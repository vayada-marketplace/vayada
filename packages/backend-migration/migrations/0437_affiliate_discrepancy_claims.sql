-- VAY-1516. Scoped, append-only support claims over authoritative affiliate evidence.
ALTER TABLE marketplace.affiliate_agreements
  ADD CONSTRAINT uq_affiliate_agreement_claim_creator
    UNIQUE (id, creator_profile_id, creator_organization_id),
  ADD CONSTRAINT uq_affiliate_agreement_claim_property UNIQUE (id, property_id);

CREATE FUNCTION marketplace.valid_affiliate_claim_references(candidate JSONB)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
  SELECT jsonb_typeof(candidate)='array'
    AND jsonb_array_length(CASE WHEN jsonb_typeof(candidate)='array' THEN candidate ELSE '[]'::jsonb END)
      BETWEEN 1 AND 20
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(candidate)='array' THEN candidate ELSE '[]'::jsonb END
      ) reference
      WHERE jsonb_typeof(reference)<>'string'
        OR length(btrim(reference#>>'{}')) NOT BETWEEN 1 AND 256
        OR (reference#>>'{}') ~* '^[a-z][a-z0-9+.-]*://'
    )
$$;

CREATE TABLE marketplace.affiliate_discrepancy_claims (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('booking_attribution','earning','payment')),
  creator_organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  creator_profile_id UUID NOT NULL,
  affiliate_id TEXT NOT NULL CHECK (length(btrim(affiliate_id)) BETWEEN 1 AND 256),
  agreement_id UUID NOT NULL REFERENCES marketplace.affiliate_agreements(id),
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  booking_id UUID NOT NULL,
  payout_id UUID REFERENCES finance.payouts(id),
  message TEXT NOT NULL CHECK (length(btrim(message)) BETWEEN 1 AND 4000),
  evidence_references JSONB NOT NULL CHECK (
    marketplace.valid_affiliate_claim_references(evidence_references)
  ),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  CONSTRAINT uq_affiliate_discrepancy_claims_duplicate UNIQUE NULLS NOT DISTINCT
    (creator_organization_id, kind, agreement_id, booking_id, payout_id),
  FOREIGN KEY (agreement_id, creator_profile_id, creator_organization_id)
    REFERENCES marketplace.affiliate_agreements(id, creator_profile_id, creator_organization_id),
  FOREIGN KEY (agreement_id, property_id)
    REFERENCES marketplace.affiliate_agreements(id, property_id),
  FOREIGN KEY (booking_id, property_id) REFERENCES booking.guest_bookings(id, property_id)
);

CREATE TABLE marketplace.affiliate_discrepancy_resolutions (
  id UUID PRIMARY KEY,
  claim_id UUID NOT NULL UNIQUE REFERENCES marketplace.affiliate_discrepancy_claims(id),
  decision TEXT NOT NULL CHECK (decision IN ('denied','confirmed_earning','confirmed_payment')),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  evidence_references JSONB NOT NULL CHECK (
    marketplace.valid_affiliate_claim_references(evidence_references)
  ),
  earning_entry_id UUID REFERENCES finance.affiliate_eligible_earning_revisions(earning_entry_id),
  payout_id UUID REFERENCES finance.payouts(id),
  idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  actor_organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  UNIQUE (actor_organization_id, idempotency_key),
  CHECK (
    (decision='denied' AND earning_entry_id IS NULL AND payout_id IS NULL)
    OR (decision='confirmed_earning' AND earning_entry_id IS NOT NULL AND payout_id IS NULL)
    OR (decision='confirmed_payment' AND earning_entry_id IS NOT NULL AND payout_id IS NOT NULL)
  )
);

CREATE FUNCTION marketplace.validate_affiliate_discrepancy_claim()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM identity.organization_resource_links link
    WHERE link.organization_id=NEW.creator_organization_id
      AND link.product='affiliate' AND link.resource_type='affiliate'
      AND link.resource_id=NEW.affiliate_id AND link.relationship='owner' AND link.status='active'
  ) THEN RAISE EXCEPTION 'affiliate claim owner scope unavailable' USING ERRCODE='23514'; END IF;

  IF NOT EXISTS (
    WITH candidates AS (
      SELECT affiliate_link.agreement_id, occurrence.clicked_at
      FROM booking.affiliate_original_booking_bindings binding
      JOIN booking.guest_bookings booking ON booking.id=binding.booking_id AND booking.property_id=binding.property_id
      JOIN booking.affiliate_click_admissions admission ON admission.context_id=binding.context_id
        AND admission.history_position<=binding.history_cutoff
      JOIN marketplace.affiliate_click_occurrences occurrence ON occurrence.id=admission.click_id
      JOIN marketplace.affiliate_links affiliate_link ON affiliate_link.id=occurrence.link_id
        AND affiliate_link.property_id=binding.property_id
      JOIN marketplace.affiliate_published_terms terms ON terms.id=occurrence.terms_id
      WHERE binding.synthetic=FALSE AND occurrence.synthetic=FALSE
        AND binding.booking_id=NEW.booking_id AND binding.property_id=NEW.property_id
        AND occurrence.clicked_at<=booking.created_at
        AND occurrence.clicked_at>=booking.created_at-
          make_interval(days=>(terms.disclosure::jsonb#>>'{terms,attributionWindowDays}')::int)
    ) SELECT 1 FROM candidates
      WHERE clicked_at=(SELECT max(clicked_at) FROM candidates)
      GROUP BY clicked_at HAVING count(*)=1 AND min(agreement_id)=NEW.agreement_id
  ) THEN RAISE EXCEPTION 'affiliate claim booking scope unavailable' USING ERRCODE='23514'; END IF;

  IF NEW.payout_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM finance.affiliate_eligible_earning_revisions earning
    JOIN finance.affiliate_earning_allocation_items item
      ON item.earning_entry_id=earning.earning_entry_id AND item.payout_id=NEW.payout_id
    WHERE earning.creator_profile_id=NEW.creator_profile_id
      AND earning.beneficiary_organization_id=NEW.creator_organization_id
      AND earning.property_id=NEW.property_id AND earning.booking_id=NEW.booking_id
      AND earning.agreement_id=NEW.agreement_id
  ) THEN RAISE EXCEPTION 'affiliate claim payout scope unavailable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION marketplace.validate_affiliate_discrepancy_resolution()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decision <> 'denied' AND NOT EXISTS (
    SELECT 1 FROM marketplace.affiliate_discrepancy_claims claim
    JOIN finance.affiliate_eligible_earning_revisions earning
      ON earning.earning_entry_id=NEW.earning_entry_id
      AND earning.creator_profile_id=claim.creator_profile_id
      AND earning.beneficiary_organization_id=claim.creator_organization_id
      AND earning.affiliate_id=claim.affiliate_id
      AND earning.property_id=claim.property_id AND earning.booking_id=claim.booking_id
      AND earning.agreement_id=claim.agreement_id
    WHERE claim.id=NEW.claim_id
  ) THEN RAISE EXCEPTION 'affiliate claim earning evidence unavailable' USING ERRCODE='23514'; END IF;
  IF NEW.decision='confirmed_payment' AND NOT EXISTS (
    SELECT 1 FROM marketplace.affiliate_discrepancy_claims claim
    JOIN finance.affiliate_earning_allocation_items item
      ON item.earning_entry_id=NEW.earning_entry_id AND item.payout_id=NEW.payout_id
    JOIN finance.affiliate_payout_payment_evidence_items payment ON payment.payout_id=item.payout_id
    WHERE claim.id=NEW.claim_id AND (claim.payout_id IS NULL OR claim.payout_id=NEW.payout_id)
  ) THEN RAISE EXCEPTION 'affiliate claim payment evidence unavailable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER affiliate_discrepancy_claims_validate BEFORE INSERT
  ON marketplace.affiliate_discrepancy_claims
  FOR EACH ROW EXECUTE FUNCTION marketplace.validate_affiliate_discrepancy_claim();
CREATE TRIGGER affiliate_discrepancy_resolutions_validate BEFORE INSERT
  ON marketplace.affiliate_discrepancy_resolutions
  FOR EACH ROW EXECUTE FUNCTION marketplace.validate_affiliate_discrepancy_resolution();

CREATE TRIGGER affiliate_discrepancy_claims_immutable
  BEFORE UPDATE OR DELETE ON marketplace.affiliate_discrepancy_claims
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_discrepancy_claims_no_truncate
  BEFORE TRUNCATE ON marketplace.affiliate_discrepancy_claims
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_discrepancy_resolutions_immutable
  BEFORE UPDATE OR DELETE ON marketplace.affiliate_discrepancy_resolutions
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER affiliate_discrepancy_resolutions_no_truncate
  BEFORE TRUNCATE ON marketplace.affiliate_discrepancy_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
