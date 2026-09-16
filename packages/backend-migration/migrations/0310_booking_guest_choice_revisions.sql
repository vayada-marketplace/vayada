-- Confirmed guest rules have no dependency on price/rate disclosures.
CREATE TABLE booking.guest_choice_revisions (
  revision UUID PRIMARY KEY,
  property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  choices JSONB NOT NULL CHECK (jsonb_typeof(choices)='object'),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(property_id,revision), UNIQUE(property_id,request_id)
);
CREATE TABLE booking.guest_choice_heads (
  property_id UUID PRIMARY KEY, revision UUID NOT NULL,
  FOREIGN KEY(property_id,revision) REFERENCES booking.guest_choice_revisions(property_id,revision)
);
CREATE TRIGGER guest_choices_immutable BEFORE UPDATE OR DELETE ON booking.guest_choice_revisions
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER guest_choices_no_truncate BEFORE TRUNCATE ON booking.guest_choice_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
