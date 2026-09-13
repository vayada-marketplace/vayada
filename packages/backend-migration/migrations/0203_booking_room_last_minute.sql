-- VAY-1543: Booking owns per-room last-minute choices; absent head means inherit.
CREATE TABLE booking.room_last_minute_revisions (
  property_id UUID NOT NULL,
  room_type_id UUID NOT NULL,
  revision UUID NOT NULL UNIQUE,
  policy JSONB NOT NULL CHECK (jsonb_typeof(policy)='object'),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  actor_user_id UUID NOT NULL REFERENCES identity.users(id),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(property_id,room_type_id,revision),
  FOREIGN KEY(room_type_id,property_id) REFERENCES pms.room_types(id,property_id),
  UNIQUE(property_id,request_id)
);
CREATE TABLE booking.room_last_minute_heads (
  property_id UUID NOT NULL, room_type_id UUID NOT NULL, revision UUID NOT NULL,
  PRIMARY KEY(property_id,room_type_id),
  FOREIGN KEY(property_id,room_type_id,revision)
    REFERENCES booking.room_last_minute_revisions(property_id,room_type_id,revision)
);
CREATE TRIGGER room_last_minute_immutable BEFORE UPDATE OR DELETE ON booking.room_last_minute_revisions
  FOR EACH ROW EXECUTE FUNCTION platform.prevent_append_only_mutation();
CREATE TRIGGER room_last_minute_no_truncate BEFORE TRUNCATE ON booking.room_last_minute_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.prevent_append_only_mutation();
