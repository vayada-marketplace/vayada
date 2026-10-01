-- VAY-1092: routing updates can move an RLS-hidden entitlement into setup scope
-- without changing organization_id, so the FK insert lock alone is insufficient.
CREATE FUNCTION platform.lock_entitlement_routing_organization()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  -- Conflicts with setup's organization FOR UPDATE until the command commits.
  -- Writers should acquire this before their row lock; reversed ordering aborts
  -- one transaction on deadlock and must be retried with fresh authorization.
  PERFORM organization.id FROM identity.organizations organization
  WHERE organization.id = NEW.organization_id FOR KEY SHARE;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.lock_entitlement_routing_organization() FROM PUBLIC;

CREATE TRIGGER entitlement_routing_organization_lock
BEFORE UPDATE ON identity.product_entitlements
FOR EACH ROW WHEN (
  ROW(OLD.organization_id, OLD.product, OLD.entitlement_key,
      OLD.resource_product, OLD.resource_type, OLD.resource_id)
  IS DISTINCT FROM
  ROW(NEW.organization_id, NEW.product, NEW.entitlement_key,
      NEW.resource_product, NEW.resource_type, NEW.resource_id)
) EXECUTE FUNCTION platform.lock_entitlement_routing_organization();
ALTER TABLE identity.product_entitlements
  ENABLE ALWAYS TRIGGER entitlement_routing_organization_lock;
