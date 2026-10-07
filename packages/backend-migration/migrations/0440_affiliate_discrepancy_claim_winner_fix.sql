-- VAY-1516: PostgreSQL has no min(uuid); assert the single winning agreement
-- with a boolean aggregate instead. This forward migration preserves the
-- immutable 0438 migration for databases where it has already run.
CREATE OR REPLACE FUNCTION marketplace.validate_affiliate_discrepancy_claim()
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
      SELECT affiliate_link.agreement_id, date_trunc('milliseconds', occurrence.clicked_at) AS clicked_at
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
      HAVING count(*)=1 AND bool_and(agreement_id=NEW.agreement_id)
  ) THEN RAISE EXCEPTION 'affiliate claim booking scope unavailable' USING ERRCODE='23514'; END IF;

  IF NEW.payout_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM finance.affiliate_eligible_earning_revisions earning
    JOIN finance.affiliate_earning_allocation_items item
      ON item.earning_entry_id=earning.earning_entry_id AND item.payout_id=NEW.payout_id
    WHERE earning.creator_profile_id=NEW.creator_profile_id
      AND earning.beneficiary_organization_id=NEW.creator_organization_id
      AND earning.affiliate_id=NEW.affiliate_id
      AND earning.property_id=NEW.property_id AND earning.booking_id=NEW.booking_id
      AND earning.agreement_id=NEW.agreement_id
  ) THEN RAISE EXCEPTION 'affiliate claim payout scope unavailable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
