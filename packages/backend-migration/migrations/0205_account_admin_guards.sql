-- VAY-1439: enforcement is opt-in after validated ownership, never an automatic demotion.
CREATE TABLE identity.account_admin_guards (
  organization_id UUID PRIMARY KEY REFERENCES identity.organizations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION identity.serialize_account_admin_change(target UUID) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- A row version write also rejects stale REPEATABLE READ/SERIALIZABLE snapshots.
  UPDATE identity.organizations SET updated_at = updated_at WHERE id = target;
END;
$$;

CREATE FUNCTION identity.lock_account_admin_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE old_org UUID; new_org UUID; target UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.role_key = OLD.role_key AND NEW.organization_id = OLD.organization_id THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.role_key IN ('hotel_owner', 'owner', 'operator') THEN
    old_org := OLD.organization_id;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.role_key IN ('hotel_owner', 'owner', 'operator') THEN
    new_org := NEW.organization_id;
  END IF;
  -- Lock even unenrolled accounts, otherwise enrollment can race an owner write.
  FOR target IN SELECT DISTINCT id FROM unnest(ARRAY[old_org, new_org]) id WHERE id IS NOT NULL ORDER BY id LOOP
    PERFORM identity.serialize_account_admin_change(target);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER lock_account_admin_membership
BEFORE INSERT OR UPDATE OR DELETE ON identity.organization_memberships
FOR EACH ROW EXECUTE FUNCTION identity.lock_account_admin_membership();

CREATE FUNCTION identity.lock_account_admin_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Account-admin enrollment is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM identity.organizations WHERE id = OLD.organization_id) THEN
      RAISE EXCEPTION 'Account-admin enrollment cannot be removed' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  PERFORM identity.serialize_account_admin_change(NEW.organization_id);
  IF NOT EXISTS (SELECT 1 FROM identity.organizations WHERE id = NEW.organization_id AND kind = 'hotel_group') THEN
    RAISE EXCEPTION 'Account-admin enrollment requires a hotel group' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER lock_account_admin_guard
BEFORE INSERT OR UPDATE OR DELETE ON identity.account_admin_guards
FOR EACH ROW EXECUTE FUNCTION identity.lock_account_admin_guard();

CREATE FUNCTION identity.check_account_admin_guard(target UUID) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE canonical_count BIGINT; alias_count BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM identity.account_admin_guards WHERE organization_id = target) THEN RETURN; END IF;
  SELECT count(*) FILTER (WHERE role_key = 'hotel_owner'),
         count(*) FILTER (WHERE role_key IN ('owner', 'operator'))
    INTO canonical_count, alias_count
    FROM identity.organization_memberships WHERE organization_id = target;
  -- Inactivation revokes access but preserves ownership until explicit transfer/recovery.
  IF canonical_count <> 1 OR alias_count <> 0 THEN
    RAISE EXCEPTION 'Enrolled account requires exactly one canonical owner' USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE FUNCTION identity.enforce_account_admin_from_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM identity.check_account_admin_guard(OLD.organization_id); END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM identity.check_account_admin_guard(NEW.organization_id); END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER enforce_account_admin_from_membership
AFTER INSERT OR UPDATE OR DELETE ON identity.organization_memberships
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION identity.enforce_account_admin_from_membership();

CREATE FUNCTION identity.enforce_account_admin_from_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM identity.check_account_admin_guard(NEW.organization_id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER enforce_account_admin_from_guard
AFTER INSERT ON identity.account_admin_guards
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION identity.enforce_account_admin_from_guard();

CREATE FUNCTION identity.preserve_enrolled_account_kind() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind <> OLD.kind AND EXISTS (SELECT 1 FROM identity.account_admin_guards WHERE organization_id = OLD.id) THEN
    RAISE EXCEPTION 'Enrolled account kind cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_enrolled_account_kind BEFORE UPDATE OF kind ON identity.organizations
FOR EACH ROW EXECUTE FUNCTION identity.preserve_enrolled_account_kind();
