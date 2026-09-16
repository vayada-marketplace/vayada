-- VAY-2021: Canonical Marketplace communication preferences; historical newsletter rows
-- are deliberately not read or copied by this forward-only migration.

CREATE TABLE marketplace.communication_preference_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES identity.users(id),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 2147483647),
  revision_transaction_id XID8 NOT NULL DEFAULT pg_current_xact_id(),
  updated_by_user_id UUID NOT NULL REFERENCES identity.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id),
  CHECK (updated_at >= created_at)
);

CREATE TABLE marketplace.communication_channel_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES identity.users(id),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  channel TEXT NOT NULL CHECK (channel = 'email'),
  state TEXT NOT NULL CHECK (state IN ('on', 'off')),
  source TEXT NOT NULL CHECK (source IN ('settings', 'signed_unsubscribe', 'explicit_opt_in')),
  effective_revision INTEGER NOT NULL CHECK (effective_revision BETWEEN 1 AND 2147483647),
  policy_version TEXT NOT NULL CHECK (policy_version = 'marketplace-communications.v1'),
  effective_at TIMESTAMPTZ NOT NULL CHECK (isfinite(effective_at)),
  updated_by_user_id UUID NOT NULL REFERENCES identity.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id, channel),
  FOREIGN KEY (user_id, organization_id)
    REFERENCES marketplace.communication_preference_sets(user_id, organization_id),
  CHECK (updated_at >= created_at)
);

CREATE TABLE marketplace.communication_topic_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES identity.users(id),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  topic TEXT NOT NULL CHECK (topic = 'collaboration_action_required'),
  channel TEXT NOT NULL CHECK (channel = 'email'),
  cadence TEXT NOT NULL CHECK (cadence IN ('immediate', 'off')),
  source TEXT NOT NULL CHECK (source IN ('settings', 'signed_unsubscribe', 'explicit_opt_in')),
  consent_classification TEXT NOT NULL CHECK (consent_classification IN ('service', 'marketing')),
  consent_reference TEXT CHECK (consent_reference IS NULL OR length(consent_reference) BETWEEN 1 AND 500),
  effective_revision INTEGER NOT NULL CHECK (effective_revision BETWEEN 1 AND 2147483647),
  policy_version TEXT NOT NULL CHECK (policy_version = 'marketplace-communications.v1'),
  effective_at TIMESTAMPTZ NOT NULL CHECK (isfinite(effective_at)),
  updated_by_user_id UUID NOT NULL REFERENCES identity.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id, topic, channel),
  FOREIGN KEY (user_id, organization_id)
    REFERENCES marketplace.communication_preference_sets(user_id, organization_id),
  CHECK (updated_at >= created_at),
  CHECK (consent_classification = 'service' OR
    (source = 'explicit_opt_in' AND consent_reference IS NOT NULL))
);

COMMENT ON COLUMN marketplace.communication_preference_sets.revision IS
  'Revision of the complete preference document returned by the API.';
COMMENT ON COLUMN marketplace.communication_preference_sets.revision_transaction_id IS
  'Internal guard binding value writes to the transaction that advanced revision.';
COMMENT ON COLUMN marketplace.communication_channel_preferences.effective_revision IS
  'Preference-set revision that last changed this value.';
COMMENT ON COLUMN marketplace.communication_topic_preferences.effective_revision IS
  'Preference-set revision that last changed this value.';

CREATE FUNCTION marketplace.guard_communication_preference()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  current_revision INTEGER;
  current_revision_transaction_id XID8;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Communication preferences cannot be deleted'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND
     (NEW.user_id, NEW.organization_id) IS DISTINCT FROM
     (OLD.user_id, OLD.organization_id) THEN
    RAISE EXCEPTION 'Communication preference scope cannot change'
      USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'communication_preference_sets' THEN
    IF (TG_OP = 'INSERT' AND NEW.revision <> 1) OR
       (TG_OP = 'UPDATE' AND NEW.revision <> OLD.revision + 1) THEN
      RAISE EXCEPTION 'Communication preference revision must advance by one'
        USING ERRCODE = '23514';
    END IF;
    NEW.revision_transaction_id := pg_current_xact_id();
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.effective_revision <= OLD.effective_revision THEN
    RAISE EXCEPTION 'Communication preference value revision must advance'
      USING ERRCODE = '23514';
  END IF;

  SELECT revision, revision_transaction_id
  INTO current_revision, current_revision_transaction_id
  FROM marketplace.communication_preference_sets
  WHERE user_id = NEW.user_id AND organization_id = NEW.organization_id;
  IF current_revision IS DISTINCT FROM NEW.effective_revision OR
     current_revision_transaction_id IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'Communication preference value must use the current transaction revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_communication_preference_set_guard
  BEFORE INSERT OR UPDATE OR DELETE ON marketplace.communication_preference_sets
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_communication_preference();
CREATE TRIGGER trg_communication_channel_preference_guard
  BEFORE INSERT OR UPDATE OR DELETE ON marketplace.communication_channel_preferences
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_communication_preference();
CREATE TRIGGER trg_communication_topic_preference_guard
  BEFORE INSERT OR UPDATE OR DELETE ON marketplace.communication_topic_preferences
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_communication_preference();

CREATE FUNCTION marketplace.require_communication_preference_value_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM marketplace.communication_channel_preferences
    WHERE user_id = NEW.user_id AND organization_id = NEW.organization_id
      AND effective_revision = NEW.revision
    UNION ALL
    SELECT 1 FROM marketplace.communication_topic_preferences
    WHERE user_id = NEW.user_id AND organization_id = NEW.organization_id
      AND effective_revision = NEW.revision
  ) THEN
    RAISE EXCEPTION 'Communication preference revision requires a value change'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_communication_preference_value_change
  AFTER INSERT OR UPDATE ON marketplace.communication_preference_sets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION marketplace.require_communication_preference_value_change();

CREATE FUNCTION marketplace.reject_communication_preference_truncate()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Communication preferences cannot be truncated'
    USING ERRCODE = '23514';
END $$;

CREATE TRIGGER trg_communication_preference_set_no_truncate
  BEFORE TRUNCATE ON marketplace.communication_preference_sets
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.reject_communication_preference_truncate();
CREATE TRIGGER trg_communication_channel_preference_no_truncate
  BEFORE TRUNCATE ON marketplace.communication_channel_preferences
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.reject_communication_preference_truncate();
CREATE TRIGGER trg_communication_topic_preference_no_truncate
  BEFORE TRUNCATE ON marketplace.communication_topic_preferences
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.reject_communication_preference_truncate();
