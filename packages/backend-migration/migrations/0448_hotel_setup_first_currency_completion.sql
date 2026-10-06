-- VAY-1092: first-currency completion for the isolated currency_ready login.
-- No login, table grant, standalone activation entry point or existing-hotel rollout.
CREATE FUNCTION platform.guard_hotel_setup_completion_evidence()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT pg_catalog.pg_has_role(session_user, 'vayada_next_hotel_setup_property_scope', 'MEMBER')
    AND session_user::text !~ '^vayada_next_hotel_setup_property_'
  THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM identity.product_entitlements
    WHERE product='pms' AND entitlement_key='module:financials'
      AND resource_product='pms' AND resource_type='pms_property'
      AND lower(resource_id)=OLD.property_id::text
      AND metadata->>'newHotelFinancialsActivationTransaction'=pg_catalog.pg_current_xact_id()::text
  ) THEN
    RAISE EXCEPTION 'Hotel setup completion evidence is sealed' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME <> 'property_pricing_settings' THEN
    NEW := pg_catalog.jsonb_populate_record(NEW, pg_catalog.jsonb_build_object(
      TG_ARGV[0], (pg_catalog.to_jsonb(NEW)->TG_ARGV[0]) ||
        pg_catalog.jsonb_build_object('hotelSetupTransaction', pg_catalog.pg_current_xact_id()::text)
    ));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.guard_hotel_setup_completion_evidence() FROM PUBLIC;

DO $$ DECLARE item RECORD; BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('platform.idempotency_keys', 'idempotency_metadata'),
    ('platform.domain_events', 'event_metadata'),
    ('platform.outbox_events', 'outbox_metadata'),
    ('platform.product_audit_events', 'audit_metadata')
  ) AS evidence(relation, metadata_column) LOOP
    EXECUTE format('CREATE TRIGGER hotel_setup_completion_evidence
      BEFORE INSERT OR UPDATE ON %s FOR EACH ROW
      EXECUTE FUNCTION platform.guard_hotel_setup_completion_evidence(%L)',
      item.relation, item.metadata_column);
    EXECUTE format('ALTER TABLE %s ENABLE ALWAYS TRIGGER hotel_setup_completion_evidence', item.relation);
  END LOOP;
END $$;
CREATE TRIGGER hotel_setup_completion_currency_seal
  BEFORE UPDATE ON pms.property_pricing_settings FOR EACH ROW
  EXECUTE FUNCTION platform.guard_hotel_setup_completion_evidence();
ALTER TABLE pms.property_pricing_settings ENABLE ALWAYS TRIGGER hotel_setup_completion_currency_seal;

CREATE FUNCTION platform.complete_hotel_setup_first_currency()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  organization UUID;
  pending identity.product_entitlements%ROWTYPE;
  proof platform.product_audit_events%ROWTYPE;
  at TIMESTAMPTZ;
  transaction_id TEXT := pg_catalog.pg_current_xact_id()::text;
BEGIN
  IF NOT platform.hotel_setup_property_operation_allowed(NEW.property_id, 'currency_ready')
  THEN RETURN NEW; END IF;
  organization := platform.hotel_setup_property_assigned_organization();
  SELECT * INTO STRICT pending FROM identity.product_entitlements
  WHERE organization_id=organization AND product='pms' AND entitlement_key='module:financials'
    AND resource_product='pms' AND resource_type='pms_property'
    AND lower(resource_id)=NEW.property_id::text FOR UPDATE;
  IF pending.status <> 'suspended' OR pending.metadata->>'newHotelFinancialsDefault' IS DISTINCT FROM 'pending'
    OR NEW.pricing_currency_revision <> 1
    OR NEW.currency::text NOT IN ('AED','AUD','BGN','BRL','CAD','CHF','CNY','CZK','DKK','EUR','GBP',
      'HKD','HRK','INR','LKR','MXN','MYR','NOK','NZD','PHP','PLN','RON','RUB','SEK','SGD','THB','TRY','USD')
    OR NOT EXISTS (SELECT 1 FROM pms.property_pricing_settings
      WHERE property_id=NEW.property_id AND currency=NEW.currency AND pricing_currency_revision=1)
  THEN RAISE EXCEPTION 'Hotel setup first currency invalid' USING ERRCODE='23514'; END IF;

  PERFORM id FROM identity.product_entitlements
  WHERE organization_id=organization AND product='pms'
    AND entitlement_key IN ('property-management','pms-core','account_access','module:financials')
    AND (resource_product IS NULL OR (resource_product='pms' AND resource_type='pms_property'
      AND lower(resource_id)=NEW.property_id::text)) FOR SHARE;
  PERFORM id FROM finance.expense_categories
  WHERE property_id=NEW.property_id AND system_key IN ('staff','ota_commission','utilities',
    'maintenance','supplies','marketing','platform_fees') FOR SHARE;
  at := pg_catalog.clock_timestamp();
  IF (pending.starts_at IS NOT NULL AND pending.starts_at > at)
    OR (pending.expires_at IS NOT NULL AND pending.expires_at <= at)
    OR EXISTS (SELECT 1 FROM identity.product_entitlements
      WHERE organization_id=organization AND product='pms' AND id<>pending.id
        AND entitlement_key IN ('property-management','pms-core','account_access','module:financials')
        AND status='suspended' AND (starts_at IS NULL OR starts_at<=at)
        AND (expires_at IS NULL OR expires_at>at)
        AND (resource_product IS NULL OR (resource_product='pms' AND resource_type='pms_property'
          AND lower(resource_id)=NEW.property_id::text)))
    OR NOT EXISTS (SELECT 1 FROM identity.product_entitlements
      WHERE organization_id=organization AND product='pms'
        AND entitlement_key IN ('property-management','pms-core','account_access') AND status='active'
        AND (starts_at IS NULL OR starts_at<=at) AND (expires_at IS NULL OR expires_at>at)
        AND (resource_product IS NULL OR (resource_product='pms' AND resource_type='pms_property'
          AND lower(resource_id)=NEW.property_id::text)))
    OR (SELECT count(*) FROM finance.expense_categories WHERE property_id=NEW.property_id
      AND archived_at IS NULL AND system_key IN ('staff','ota_commission','utilities',
        'maintenance','supplies','marketing','platform_fees')) <> 7
  THEN RAISE EXCEPTION 'Hotel setup Financials prerequisites incomplete' USING ERRCODE='23514'; END IF;

  SELECT a.* INTO STRICT proof FROM platform.product_audit_events a
  JOIN platform.idempotency_keys k ON k.id=a.idempotency_key_id AND k.property_id=a.property_id
  JOIN platform.domain_events e ON e.id=a.domain_event_id AND e.property_id=a.property_id
  WHERE a.property_id=NEW.property_id AND a.tenant_scope='property' AND a.organization_id IS NULL
    AND a.product='pms' AND a.action='pms.pricing_currency.upsert' AND a.actor_type='user'
    AND a.target_resource_product='pms' AND a.target_resource_type='property_pricing'
    AND a.target_resource_id=NEW.property_id::text
    AND a.audit_metadata->>'actorOrganizationId'=organization::text
    AND a.audit_metadata->>'hotelSetupTransaction'=transaction_id
    AND a.redacted_payload @> pg_catalog.jsonb_build_object('propertyId', NEW.property_id::text,
      'outcome','created','expectedPricingCurrencyRevision',0,'resultingPricingCurrencyRevision',1)
    AND k.operation_scope='pms' AND k.operation='pms.pricing_currency.upsert'
    AND k.tenant_scope='property' AND k.organization_id IS NULL AND k.status='completed'
    AND k.response_status_code=201 AND k.idempotency_metadata->>'hotelSetupTransaction'=transaction_id
    AND k.idempotency_metadata->'result' @> pg_catalog.jsonb_build_object('ok',true,'response',
      pg_catalog.jsonb_build_object('outcome','created','pricingCurrency',pg_catalog.jsonb_build_object(
        'propertyId',NEW.property_id::text,'currency',NEW.currency::text,'pricingCurrencyRevision',1)))
    AND e.source_system='pms' AND e.event_type='pms.pricing_source.changed' AND e.event_version=1
    AND e.tenant_scope='property' AND e.organization_id IS NULL AND e.resource_product='pms'
    AND e.resource_type='property_pricing' AND e.resource_id=NEW.property_id::text
    AND e.actor_type='user' AND e.actor_user_id=a.actor_user_id AND e.idempotency_key_hash=k.key_hash
    AND e.event_metadata->>'hotelSetupTransaction'=transaction_id
    AND e.correlation_id IS NOT DISTINCT FROM a.correlation_id
    AND k.correlation_id IS NOT DISTINCT FROM a.correlation_id
    AND e.payload @> pg_catalog.jsonb_build_object('propertyId',NEW.property_id::text,
      'outcome','currency_created','pricingCurrencyRevision',1,'flexibleRatePlanId',NULL,
      'flexibleRatePlanRevision',NULL)
    AND (SELECT count(DISTINCT o.destination) FROM platform.outbox_events o
      WHERE o.domain_event_id=e.id AND o.property_id=NEW.property_id
        AND o.tenant_scope='property' AND o.organization_id IS NULL
        AND o.destination IN ('booking.pricing-source','finance.pricing-source')
        AND o.event_type=e.event_type AND o.resource_product=e.resource_product
        AND o.resource_type=e.resource_type AND o.resource_id=e.resource_id
        AND o.idempotency_key_hash=k.key_hash AND o.payload=e.payload
        AND o.correlation_id IS NOT DISTINCT FROM a.correlation_id
        AND o.outbox_metadata->>'hotelSetupTransaction'=transaction_id) = 2;

  UPDATE identity.product_entitlements SET status='active', updated_at=at,
    metadata=metadata || pg_catalog.jsonb_build_object('newHotelFinancialsDefault','ready',
      'newHotelFinancialsActivationTransaction',transaction_id)
  WHERE id=pending.id;
  INSERT INTO platform.product_audit_events (audit_key,product,action,occurred_at,tenant_scope,
    property_id,actor_type,actor_user_id,target_resource_product,target_resource_type,
    target_resource_id,domain_event_id,idempotency_key_id,correlation_id,causation_id,
    redacted_payload,audit_metadata,privacy_scope)
  VALUES (proof.audit_key || '.financials-default','pms','pms.financials.default_activated',at,
    'property',NEW.property_id,'user',proof.actor_user_id,'pms','pms_property',NEW.property_id::text,
    proof.domain_event_id,proof.idempotency_key_id,proof.correlation_id,proof.causation_id,
    pg_catalog.jsonb_build_object('propertyId',NEW.property_id::text,'currency',NEW.currency::text),
    pg_catalog.jsonb_build_object('sourceAuditId',proof.id::text,'actorOrganizationId',organization::text),
    'confidential');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.complete_hotel_setup_first_currency() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER hotel_setup_first_currency_completion
  AFTER INSERT ON pms.property_pricing_settings DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.complete_hotel_setup_first_currency();
ALTER TABLE pms.property_pricing_settings ENABLE ALWAYS TRIGGER hotel_setup_first_currency_completion;
