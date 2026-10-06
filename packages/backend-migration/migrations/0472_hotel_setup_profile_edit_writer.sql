-- VAY-965: fixed profile-edit writer for the actor-bound property_profile login.
-- Needs 0470 authority and 0471 projection; still no login, credential or table grant.
-- Persistence matches the shared profile writer; statements are sequential so contact
-- removals are visible to the following upsert. Replay and conflicts write nothing.
CREATE FUNCTION platform.hotel_setup_update_property_profile(
  requested_property_id UUID, requested_organization_id UUID, requested_actor_user_id UUID,
  expected_revision BIGINT, requested_profile JSONB, requested_key_hash TEXT,
  requested_fingerprint TEXT, requested_correlation TEXT
) RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE replay RECORD; current_revision BIGINT; before JSONB; after JSONB; key_id UUID; changed TEXT[];
BEGIN
  IF NOT platform.hotel_setup_profile_authority(requested_property_id,requested_organization_id,requested_actor_user_id,FALSE)
  THEN RAISE EXCEPTION 'hotel setup profile forbidden' USING ERRCODE='42501'; END IF;
  IF requested_key_hash !~ '^[0-9a-f]{64}$' OR requested_fingerprint !~ '^[0-9a-f]{64}$'
    OR expected_revision IS NULL OR expected_revision < 1
    OR jsonb_typeof(requested_profile) IS DISTINCT FROM 'object' OR jsonb_typeof(requested_profile->'contacts') IS DISTINCT FROM 'array'
    OR jsonb_array_length(requested_profile->'contacts') > 50 OR NULLIF(btrim(requested_profile->>'display_name'),'') IS NULL
    OR length(requested_profile->>'display_name') > 200 OR requested_correlation IS NULL OR length(requested_correlation) NOT BETWEEN 1 AND 200
    OR COALESCE(requested_profile->>'property_type','') <> ALL(ARRAY['hotel','resort','hostel','apartment',
      'aparthotel','guesthouse','bed_and_breakfast','villa','vacation_rental','motel','other'])
    OR length(requested_profile->>'street_address') > 240 OR length(requested_profile->>'postal_code') > 32
    OR length(requested_profile->>'city') > 120 OR length(requested_profile->>'timezone') > 80
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(requested_profile->'contacts') contact
      WHERE jsonb_typeof(contact->'is_public') IS DISTINCT FROM 'boolean'
        OR NULLIF(contact->>'value','') IS NULL)
  THEN RAISE EXCEPTION 'hotel setup profile request invalid' USING ERRCODE='22023'; END IF;

  SELECT id, request_fingerprint_hash AS fingerprint INTO replay FROM platform.idempotency_keys
    WHERE operation_scope='hotel_catalog' AND operation='hotel_setup_property_profile_update'
      AND tenant_scope='property' AND property_id=requested_property_id AND key_hash=requested_key_hash
    FOR UPDATE;
  IF FOUND THEN
    IF replay.fingerprint IS DISTINCT FROM requested_fingerprint THEN
      RETURN jsonb_build_object('status','idempotency_conflict');
    END IF;
    RETURN jsonb_build_object('status','replayed','profile',platform.hotel_setup_property_profile_row(requested_property_id));
  END IF;

  SELECT property.profile_revision INTO current_revision FROM hotel_catalog.properties property
    WHERE property.id=requested_property_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hotel setup profile property missing' USING ERRCODE='42501'; END IF;
  IF current_revision<>expected_revision THEN
    RETURN jsonb_build_object('status','conflict','currentRevision',current_revision);
  END IF;
  -- Never publish or re-own a contact the profile does not show (private or another product's).
  IF EXISTS (SELECT 1 FROM hotel_catalog.property_contact_channels contact
    JOIN jsonb_to_recordset(requested_profile->'contacts') input(channel_type text, value text)
      ON input.channel_type=contact.channel_type AND input.value=contact.value
    WHERE contact.property_id=requested_property_id AND contact.source_system<>'platform'
      AND NOT (contact.is_public AND contact.channel_type IN ('phone','whatsapp','email')))
  THEN RETURN jsonb_build_object('status','private_contact_conflict'); END IF;
  before := platform.hotel_setup_property_profile_row(requested_property_id);

  UPDATE hotel_catalog.properties
    SET display_name=requested_profile->>'display_name', property_type=requested_profile->>'property_type',
        profile_revision=profile_revision+1, updated_at=now()
    WHERE id=requested_property_id AND profile_revision=expected_revision;
  INSERT INTO hotel_catalog.property_locations (property_id, country_code, city, street_address,
      postal_code, latitude, longitude, timezone, address_public, geo_public, map_display_mode,
      source_confidence, updated_at)
    SELECT requested_property_id, NULLIF(input.country_code,'')::char(2), input.city, input.street_address,
      input.postal_code, input.latitude, input.longitude, input.timezone, input.address_public,
      input.geo_public, COALESCE(input.map_display_mode,'hidden'), 'verified', now()
    FROM jsonb_to_record(requested_profile) AS input(country_code text, city text, street_address text,
      postal_code text, timezone text, latitude numeric, longitude numeric, address_public boolean,
      geo_public boolean, map_display_mode text)
    ON CONFLICT (property_id) DO UPDATE
    SET country_code=EXCLUDED.country_code, city=EXCLUDED.city, street_address=EXCLUDED.street_address,
        postal_code=EXCLUDED.postal_code, latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude,
        timezone=EXCLUDED.timezone, address_public=EXCLUDED.address_public, geo_public=EXCLUDED.geo_public,
        map_display_mode=EXCLUDED.map_display_mode, source_confidence=EXCLUDED.source_confidence, updated_at=now();
  DELETE FROM hotel_catalog.property_contact_channels contact
    WHERE contact.property_id=requested_property_id AND contact.source_system='platform'
      AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(requested_profile->'contacts') input(channel_type text, value text)
        WHERE input.channel_type=contact.channel_type AND input.value=contact.value);
  DELETE FROM hotel_catalog.property_contact_channels contact
    WHERE contact.property_id=requested_property_id AND contact.source_system<>'platform'
      AND contact.is_public AND contact.channel_type IN ('phone','whatsapp','email');
  INSERT INTO hotel_catalog.property_contact_channels (property_id, channel_type, value, purpose,
      is_public, source_system, updated_at)
    SELECT requested_property_id, input.channel_type, input.value, input.purpose, input.is_public, 'platform', now()
    FROM jsonb_to_recordset(requested_profile->'contacts') input(channel_type text, value text, purpose text, is_public boolean)
    ON CONFLICT (property_id, channel_type, value) DO UPDATE
    SET purpose=EXCLUDED.purpose, is_public=EXCLUDED.is_public, source_system=EXCLUDED.source_system, updated_at=now();
  PERFORM platform.hotel_setup_sync_property_read_models(requested_property_id);

  after := platform.hotel_setup_property_profile_row(requested_property_id);
  SELECT COALESCE(array_agg(entry.key ORDER BY entry.key), '{}') INTO changed FROM jsonb_each(after) entry
    WHERE entry.key NOT IN ('propertyId','profileRevision') AND before->entry.key IS DISTINCT FROM entry.value;
  INSERT INTO platform.idempotency_keys (operation_scope, operation, key_hash, request_fingerprint_hash,
      status, tenant_scope, property_id, response_status_code, response_resource_product,
      response_resource_type, response_resource_id, correlation_id, completed_at, expires_at)
    VALUES ('hotel_catalog', 'hotel_setup_property_profile_update', requested_key_hash,
      requested_fingerprint, 'completed', 'property', requested_property_id, 200, 'hotel_catalog',
      'property', requested_property_id::text, requested_correlation, now(), now() + interval '30 days')
    RETURNING id INTO key_id;
  INSERT INTO platform.product_audit_events (audit_key, product, action, occurred_at, tenant_scope,
      property_id, actor_type, actor_user_id, target_resource_product, target_resource_type,
      target_resource_id, correlation_id, idempotency_key_id, redacted_payload, audit_metadata,
      retention_class, privacy_scope)
    VALUES ('hotel_setup_property_profile:' || key_id::text, 'hotel_catalog', 'property_profile_updated',
      clock_timestamp(), 'property', requested_property_id, 'user', requested_actor_user_id,
      'hotel_catalog', 'property', requested_property_id::text, requested_correlation, key_id,
      jsonb_build_object('operation','property_profile','changedFields',to_jsonb(changed),
        'profileRevision',after->'profileRevision'),
      jsonb_build_object('actorOrganizationId',requested_organization_id::text), 'standard', 'internal');
  RETURN jsonb_build_object('status','updated','profile',after);
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_update_property_profile(UUID,UUID,UUID,BIGINT,JSONB,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_update_property_profile(UUID,UUID,UUID,BIGINT,JSONB,TEXT,TEXT,TEXT)
  TO vayada_next_hotel_setup_profile_scope;
