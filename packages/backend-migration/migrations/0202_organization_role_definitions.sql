-- VAY-1439: Tenant-owned role definitions. Existing members retain legacy
-- authorization until an explicit role assignment is made by a supported writer.
CREATE TABLE identity.organization_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES identity.organizations(id),
  name TEXT NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  security_class TEXT NOT NULL CHECK (security_class IN ('account_admin', 'staff', 'housekeeping', 'external_owner')),
  base_role_key TEXT NOT NULL,
  preset_key TEXT CHECK (preset_key IN ('account_admin', 'agency_manager', 'property_owner', 'reservation_manager', 'front_desk', 'housekeeping')),
  default_permissions JSONB NOT NULL CHECK (
    jsonb_typeof(default_permissions) = 'array'
    AND NOT jsonb_path_exists(default_permissions, '$[*] ? (@.type() != "string")')
  ),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, preset_key),
  CHECK (
    (security_class = 'account_admin' AND base_role_key = 'hotel_owner' AND preset_key IS NOT DISTINCT FROM 'account_admin')
    OR (security_class = 'staff' AND base_role_key IN ('hotel_manager', 'front_desk', 'hotel_custom') AND preset_key IS DISTINCT FROM 'account_admin')
    OR (security_class = 'housekeeping' AND base_role_key = 'housekeeping' AND preset_key IS DISTINCT FROM 'account_admin')
    OR (security_class = 'external_owner' AND base_role_key = 'external_owner' AND preset_key IS DISTINCT FROM 'account_admin')
  ),
  CHECK (preset_key IS NULL OR base_role_key = CASE preset_key
    WHEN 'account_admin' THEN 'hotel_owner'
    WHEN 'agency_manager' THEN 'hotel_manager'
    WHEN 'property_owner' THEN 'external_owner'
    WHEN 'reservation_manager' THEN 'hotel_custom'
    WHEN 'front_desk' THEN 'front_desk'
    WHEN 'housekeeping' THEN 'housekeeping' END)
);

CREATE UNIQUE INDEX uq_organization_roles_name
  ON identity.organization_roles (organization_id, lower(name));

CREATE FUNCTION identity.protect_role_definition_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.security_class = 'account_admin' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'account admin role is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF ROW(NEW.organization_id, NEW.security_class, NEW.base_role_key, NEW.preset_key)
     IS DISTINCT FROM ROW(OLD.organization_id, OLD.security_class, OLD.base_role_key, OLD.preset_key) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'role identity and security class are immutable';
  END IF;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER protect_role_definition_identity
BEFORE UPDATE OR DELETE ON identity.organization_roles
FOR EACH ROW EXECUTE FUNCTION identity.protect_role_definition_identity();

ALTER TABLE identity.organization_memberships
  ADD COLUMN role_definition_id UUID,
  ADD CONSTRAINT fk_membership_role_definition_scope
    FOREIGN KEY (role_definition_id, organization_id)
    REFERENCES identity.organization_roles (id, organization_id);

ALTER TABLE identity.staff_invitations
  ADD COLUMN role_definition_id UUID,
  ADD CONSTRAINT fk_invitation_role_definition_scope
    FOREIGN KEY (role_definition_id, organization_id)
    REFERENCES identity.organization_roles (id, organization_id);

CREATE INDEX idx_membership_role_definition ON identity.organization_memberships (role_definition_id)
  WHERE role_definition_id IS NOT NULL;
CREATE INDEX idx_invitation_role_definition ON identity.staff_invitations (role_definition_id)
  WHERE role_definition_id IS NOT NULL;
