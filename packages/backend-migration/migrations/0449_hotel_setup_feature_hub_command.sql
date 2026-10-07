-- VAY-1092: audited native Feature Hub command, with no direct entitlement grant.
CREATE FUNCTION platform.guard_hotel_setup_owner_off_receipt()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.metadata ? 'newHotelFinancialsOwnerDisabled' OR OLD.metadata ? 'newHotelFinancialsOwnerDisabled' THEN
    IF TG_OP='UPDATE' AND session_user::text ~ '^vayada_next_hotel_setup_property_'
      AND NEW.product='pms' AND NEW.entitlement_key='module:financials'
      AND NEW.resource_product='pms' AND NEW.resource_type='pms_property'
      AND pg_catalog.pg_input_is_valid(NEW.resource_id,'uuid')
      AND platform.hotel_setup_property_allowed(NEW.resource_id::uuid,NEW.organization_id)
      AND platform.hotel_setup_property_operation_allowed(NEW.resource_id::uuid,'feature_hub')
    THEN RETURN NEW; END IF;
    NEW.metadata := NEW.metadata - 'newHotelFinancialsOwnerDisabled';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.guard_hotel_setup_owner_off_receipt() FROM PUBLIC;
CREATE TRIGGER hotel_setup_owner_off_receipt BEFORE INSERT OR UPDATE ON identity.product_entitlements
  FOR EACH ROW EXECUTE FUNCTION platform.guard_hotel_setup_owner_off_receipt();
ALTER TABLE identity.product_entitlements ENABLE ALWAYS TRIGGER hotel_setup_owner_off_receipt;

CREATE FUNCTION platform.apply_hotel_setup_feature_hub_command()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE organization UUID; entitlement identity.product_entitlements%ROWTYPE;
DECLARE enabled BOOLEAN; at TIMESTAMPTZ;
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user,'vayada_next_hotel_setup_property_scope','MEMBER')
    AND session_user::text !~ '^vayada_next_hotel_setup_property_'
  THEN RETURN NEW; END IF;
  IF NEW.action NOT IN ('financials_module_activated','financials_module_deactivated') THEN RETURN NEW; END IF;
  enabled := NEW.action='financials_module_activated';
  organization := platform.hotel_setup_property_assigned_organization();
  IF (NEW.product='pms' AND NEW.tenant_scope='property' AND NEW.organization_id IS NULL
    AND platform.hotel_setup_property_operation_allowed(NEW.property_id,'feature_hub')
    AND NEW.target_resource_product='pms' AND NEW.target_resource_type='pms_property'
    AND NEW.target_resource_id=NEW.property_id::text AND NEW.actor_type='user'
    AND EXISTS (SELECT 1 FROM identity.organization_memberships m JOIN identity.users u ON u.id=m.user_id
      WHERE m.organization_id=organization AND m.user_id=NEW.actor_user_id
        AND m.status='active' AND m.pms_access_enabled AND u.status='active')
    AND NEW.secondary_resource_product IS NULL AND NEW.secondary_resource_type IS NULL
    AND NEW.secondary_resource_id IS NULL AND NEW.job_id IS NULL AND NEW.external_webhook_event_id IS NULL
    AND NEW.domain_event_id IS NULL AND NEW.idempotency_key_id IS NULL
    AND NEW.private_payload='{}'::jsonb
    AND NEW.redacted_payload=pg_catalog.jsonb_build_object('moduleId','financials','isActive',enabled)
    AND NEW.retention_class='financial' AND NEW.privacy_scope='internal') IS NOT TRUE
  THEN RAISE EXCEPTION 'Hotel setup Financials audit invalid' USING ERRCODE='42501'; END IF;
  IF TG_WHEN='BEFORE' THEN
    NEW.occurred_at := pg_catalog.clock_timestamp();
    NEW.audit_metadata := pg_catalog.jsonb_build_object('actorOrganizationId',organization::text,
      'hotelSetupTransaction',pg_catalog.pg_current_xact_id()::text);
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT entitlement FROM identity.product_entitlements
  WHERE organization_id=organization AND product='pms' AND entitlement_key='module:financials'
    AND resource_product='pms' AND resource_type='pms_property'
    AND lower(resource_id)=NEW.property_id::text FOR UPDATE;
  PERFORM id FROM identity.product_entitlements WHERE organization_id=organization AND product='pms'
    AND entitlement_key IN ('property-management','pms-core','account_access','module:financials')
    AND (resource_product IS NULL OR (resource_product='pms' AND resource_type='pms_property'
      AND lower(resource_id)=NEW.property_id::text)) FOR SHARE;
  PERFORM property_id FROM pms.property_pricing_settings WHERE property_id=NEW.property_id FOR SHARE;
  at := pg_catalog.clock_timestamp();
  IF enabled AND (
    entitlement.metadata->>'newHotelFinancialsDefault' IS DISTINCT FROM 'ready'
    OR NOT (entitlement.metadata ? 'newHotelFinancialsActivationTransaction')
    OR (entitlement.status<>'active' AND (entitlement.status<>'suspended'
      OR entitlement.metadata->'newHotelFinancialsOwnerDisabled' IS DISTINCT FROM 'true'::jsonb))
    OR (entitlement.starts_at IS NOT NULL AND entitlement.starts_at>at)
    OR (entitlement.expires_at IS NOT NULL AND entitlement.expires_at<=at)
    OR NOT EXISTS (SELECT 1 FROM pms.property_pricing_settings WHERE property_id=NEW.property_id
      AND currency::text IN ('AED','AUD','BGN','BRL','CAD','CHF','CNY','CZK','DKK','EUR','GBP',
        'HKD','HRK','INR','LKR','MXN','MYR','NOK','NZD','PHP','PLN','RON','RUB','SEK','SGD','THB','TRY','USD'))
    OR EXISTS (SELECT 1 FROM identity.product_entitlements WHERE organization_id=organization AND product='pms'
      AND id<>entitlement.id AND entitlement_key IN ('property-management','pms-core','account_access','module:financials')
      AND status='suspended' AND (starts_at IS NULL OR starts_at<=at) AND (expires_at IS NULL OR expires_at>at)
      AND (resource_product IS NULL OR (resource_product='pms' AND resource_type='pms_property'
        AND lower(resource_id)=NEW.property_id::text)))
    OR NOT EXISTS (SELECT 1 FROM identity.product_entitlements WHERE organization_id=organization AND product='pms'
      AND entitlement_key IN ('property-management','pms-core','account_access') AND status='active'
      AND (starts_at IS NULL OR starts_at<=at) AND (expires_at IS NULL OR expires_at>at)
      AND (resource_product IS NULL OR (resource_product='pms' AND resource_type='pms_property'
        AND lower(resource_id)=NEW.property_id::text)))
  ) THEN RAISE EXCEPTION 'Hotel setup Financials activation unavailable' USING ERRCODE='23514'; END IF;
  UPDATE identity.product_entitlements SET status=CASE WHEN enabled THEN 'active' ELSE 'suspended' END,
    updated_at=at, metadata=metadata || pg_catalog.jsonb_build_object('newHotelFinancialsOwnerDisabled',
      NOT enabled AND (entitlement.status='active' OR COALESCE(entitlement.metadata->'newHotelFinancialsOwnerDisabled'='true'::jsonb,false)))
  WHERE id=entitlement.id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.apply_hotel_setup_feature_hub_command() FROM PUBLIC;
CREATE TRIGGER hotel_setup_feature_hub_command BEFORE INSERT ON platform.product_audit_events
  FOR EACH ROW EXECUTE FUNCTION platform.apply_hotel_setup_feature_hub_command();
ALTER TABLE platform.product_audit_events ENABLE ALWAYS TRIGGER hotel_setup_feature_hub_command;
CREATE TRIGGER hotel_setup_feature_hub_apply AFTER INSERT ON platform.product_audit_events
  FOR EACH ROW EXECUTE FUNCTION platform.apply_hotel_setup_feature_hub_command();
ALTER TABLE platform.product_audit_events ENABLE ALWAYS TRIGGER hotel_setup_feature_hub_apply;

-- Preserve the prior currency predicate exactly; add only the audited command shape.
DO $$ DECLARE old_predicate TEXT; predicate TEXT; BEGIN
  SELECT pg_catalog.pg_get_expr(polqual,polrelid) INTO STRICT old_predicate FROM pg_catalog.pg_policy
    WHERE polrelid='platform.product_audit_events'::regclass AND polname='hotel_setup_currency_evidence_scope';
  predicate := old_predicate || $predicate$ OR (
    tenant_scope='property' AND organization_id IS NULL
    AND platform.hotel_setup_property_row_allowed(property_id)
    AND platform.hotel_setup_property_operation_allowed(property_id,'feature_hub')
    AND product='pms' AND action IN ('financials_module_activated','financials_module_deactivated')
    AND target_resource_product='pms' AND target_resource_type='pms_property' AND target_resource_id=property_id::text
    AND actor_type='user' AND private_payload='{}'::jsonb
    AND audit_metadata->>'actorOrganizationId'=platform.hotel_setup_property_assigned_organization()::text
    AND redacted_payload=pg_catalog.jsonb_build_object('moduleId','financials','isActive',action='financials_module_activated')
    AND domain_event_id IS NULL AND idempotency_key_id IS NULL AND job_id IS NULL
    AND external_webhook_event_id IS NULL AND secondary_resource_product IS NULL
    AND secondary_resource_type IS NULL AND secondary_resource_id IS NULL
    AND retention_class='financial' AND privacy_scope='internal'
  )$predicate$;
  EXECUTE pg_catalog.format('ALTER POLICY hotel_setup_currency_evidence_scope ON platform.product_audit_events
    USING (%s) WITH CHECK (%s)',predicate,predicate);
END $$;
