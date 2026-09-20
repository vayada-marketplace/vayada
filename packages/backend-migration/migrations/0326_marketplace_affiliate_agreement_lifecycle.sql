-- VAY-1502. Affiliate agreement lifecycle is independent of collaboration status.
-- The activation is revision 0. Commands will append revisions 1, 2, ...
CREATE TABLE marketplace.affiliate_agreement_lifecycle_events (
  id UUID PRIMARY KEY,
  agreement_id UUID NOT NULL
    REFERENCES marketplace.affiliate_agreement_activations(agreement_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  action TEXT NOT NULL CHECK (action IN ('pause', 'resume', 'end')),
  actor_side TEXT NOT NULL CHECK (actor_side IN ('hotel', 'creator')),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  actor_organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  request_id TEXT NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 200),
  effective_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(effective_at)),
  UNIQUE (agreement_id, revision)
);

-- An event takes effect when Vayada records it; callers cannot schedule or backdate it.
CREATE FUNCTION marketplace.stamp_affiliate_agreement_lifecycle_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Status readers lock this activation too. Stamp only after that lock is acquired.
  PERFORM 1 FROM marketplace.affiliate_agreement_activations
    WHERE agreement_id=NEW.agreement_id FOR UPDATE;
  NEW.effective_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER affiliate_agreement_lifecycle_events_server_time
  BEFORE INSERT ON marketplace.affiliate_agreement_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION marketplace.stamp_affiliate_agreement_lifecycle_event();

CREATE TRIGGER affiliate_agreement_lifecycle_events_immutable
  BEFORE UPDATE OR DELETE ON marketplace.affiliate_agreement_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
CREATE TRIGGER affiliate_agreement_lifecycle_events_no_truncate
  BEFORE TRUNCATE ON marketplace.affiliate_agreement_lifecycle_events
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.reject_affiliate_offer_draft_mutation();
