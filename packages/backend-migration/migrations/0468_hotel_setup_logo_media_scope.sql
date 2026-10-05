-- VAY-965: property-logo native inventory; no login or credential activation.
ALTER TABLE platform.media_upload_sessions ADD COLUMN private_artifact_manifest JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE FUNCTION platform.hotel_setup_logo_authority(
  requested_property_id UUID, requested_organization_id UUID, requested_actor_user_id UUID, allow_pending BOOLEAN
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog AS $$
DECLARE assignment RECORD; locked_member RECORD; definition RECORD; login_oid OID; parent_oid OID;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
    OR session_user::text !~ '^vayada_next_hotel_setup_logo_[a-z0-9_]+$'
  THEN RETURN FALSE; END IF;
  SELECT oid INTO parent_oid FROM pg_catalog.pg_roles
    WHERE rolname='vayada_next_hotel_setup_logo_scope'
      AND NOT (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);
  SELECT oid INTO login_oid FROM pg_catalog.pg_roles
    WHERE rolname=session_user AND rolcanlogin AND rolvaliduntil IS NULL
      AND NOT (rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);
  IF parent_oid IS NULL OR login_oid IS NULL
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=parent_oid)
    OR (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member=login_oid)<>1
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
      WHERE member=login_oid AND roleid=parent_oid AND inherit_option AND NOT set_option AND NOT admin_option)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid=login_oid)
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting setting WHERE setting.setrole IN (login_oid,parent_oid))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend dependency
      WHERE dependency.refclassid='pg_catalog.pg_authid'::regclass AND dependency.refobjid=login_oid
        AND dependency.deptype='o' AND (dependency.dbid=0 OR dependency.dbid=(
          SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())))
  THEN RETURN FALSE; END IF;

  SELECT scope.property_id, scope.organization_id, scope.actor_user_id INTO assignment
    FROM platform.hotel_setup_property_scopes scope
    JOIN identity.organizations organization ON organization.id=scope.organization_id
    WHERE scope.database_login=session_user AND scope.active AND scope.operation_class='property_logo'
      AND scope.property_id=requested_property_id AND scope.organization_id=requested_organization_id
      AND scope.actor_user_id=requested_actor_user_id
      AND ((allow_pending AND scope.credential_role_oid IS NULL AND scope.credential_secret_version IS NULL AND scope.credential_ready_at IS NULL)
        OR (NOT allow_pending AND scope.credential_role_oid=login_oid AND scope.credential_secret_version IS NOT NULL AND scope.credential_ready_at IS NOT NULL))
      AND organization.kind='hotel_group' AND organization.status='active'
    -- ponytail: reuse the existing organization-wide setup lock to serialize revocation.
    FOR UPDATE OF organization FOR SHARE OF scope;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  SELECT membership.* INTO locked_member FROM identity.organization_memberships membership
    WHERE membership.organization_id=assignment.organization_id AND membership.user_id=assignment.actor_user_id
      AND membership.status='active' FOR SHARE;
  IF NOT FOUND OR locked_member.role_key<>'hotel_owner'
    OR (locked_member.permission_overrides IS NOT NULL AND locked_member.permission_overrides<>'{"grant":[],"deny":[]}'::jsonb)
  THEN RETURN FALSE; END IF;
  IF locked_member.role_definition_id IS NOT NULL THEN
    SELECT role.* INTO definition FROM identity.organization_roles role
      WHERE role.id=locked_member.role_definition_id AND role.organization_id=assignment.organization_id FOR SHARE;
    IF NOT FOUND OR definition.security_class<>'account_admin' OR definition.base_role_key<>'hotel_owner'
      OR definition.preset_key IS DISTINCT FROM 'account_admin' OR definition.default_permissions<>'[]'::jsonb
    THEN RETURN FALSE; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM identity.role_permission_grants permission
    WHERE permission.organization_kind='hotel_group' AND permission.role_key='hotel_owner'
      AND permission.permission_key='hotel_catalog.setup.manage' FOR SHARE)
    OR NOT EXISTS (SELECT 1 FROM identity.users actor
      WHERE actor.id=assignment.actor_user_id AND actor.status='active' FOR SHARE)
    OR NOT (locked_member.property_access_mode='all' OR (locked_member.property_access_mode='assigned'
      AND EXISTS (SELECT 1 FROM identity.membership_property_assignments property_assignment
        WHERE property_assignment.membership_id=locked_member.id AND property_assignment.property_id=assignment.property_id FOR SHARE)))
  THEN RETURN FALSE; END IF;
  RETURN EXISTS (SELECT 1 FROM identity.organization_resource_links owner_link
    JOIN hotel_catalog.properties property ON property.id=assignment.property_id AND property.lifecycle_status<>'retired'
    WHERE owner_link.organization_id=assignment.organization_id AND owner_link.product='hotel_catalog'
      AND owner_link.resource_type='property' AND lower(owner_link.resource_id)=assignment.property_id::text
      AND owner_link.relationship='owner' AND owner_link.status='active' FOR SHARE OF owner_link,property);
END $$;

REVOKE ALL ON FUNCTION platform.hotel_setup_logo_authority(UUID,UUID,UUID,BOOLEAN) FROM PUBLIC;
CREATE OR REPLACE FUNCTION platform.hotel_setup_logo_allowed(requested_property_id UUID,requested_organization_id UUID,requested_actor_user_id UUID) RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT platform.hotel_setup_logo_authority(requested_property_id,requested_organization_id,requested_actor_user_id,FALSE);
$$;
CREATE FUNCTION platform.hotel_setup_logo_bootstrap_proof_allowed(property UUID,organization UUID,actor UUID) RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT platform.hotel_setup_logo_authority(property,organization,actor,TRUE);
$$;
-- Reserve every v2 file UUID across sessions before any manifest can name a private key.
CREATE FUNCTION platform.hotel_setup_media_session_allocation_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE media TEXT; files JSONB := NEW.completion_metadata->'session'->'files';
BEGIN
 IF TG_OP='UPDATE' AND OLD.requested_purpose='property.logo' AND EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.private_artifact_manifest) e WHERE NOT NEW.private_artifact_manifest @> jsonb_build_array(e)) THEN
 RAISE EXCEPTION 'logo private artifact manifest cannot discard acknowledged keys' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(files) IS DISTINCT FROM 'array' THEN RETURN NEW; END IF;
 IF jsonb_array_length(files)>25 THEN RAISE EXCEPTION 'media session file limit' USING ERRCODE='23514'; END IF;
 FOR media IN SELECT DISTINCT value->>'mediaId' FROM jsonb_array_elements(files)
 WHERE value->>'mediaId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' ORDER BY 1 LOOP
 PERFORM pg_advisory_xact_lock(hashtextextended('platform.media-session-file:'||media,0));
 IF TG_OP='INSERT' AND NEW.requested_purpose='property.logo' AND NEW.session_status='signed'
 AND EXISTS(SELECT 1 FROM platform.media_objects WHERE id::text=media) THEN
 RAISE EXCEPTION 'logo file UUID already registered' USING ERRCODE='23505'; END IF;
 IF EXISTS(SELECT 1 FROM platform.media_upload_sessions s,
 LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.completion_metadata->'session'->'files')='array'
 THEN s.completion_metadata->'session'->'files' ELSE '[]'::jsonb END) f
 WHERE s.id<>NEW.id AND f->>'mediaId'=media) THEN
 RAISE EXCEPTION 'media file UUID already allocated' USING ERRCODE='23505'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_media_session_allocation_guard() FROM PUBLIC;
CREATE TRIGGER hotel_setup_media_session_allocation_guard
BEFORE INSERT OR UPDATE OF completion_metadata,private_artifact_manifest ON platform.media_upload_sessions
FOR EACH ROW EXECUTE FUNCTION platform.hotel_setup_media_session_allocation_guard();
GRANT USAGE ON SCHEMA hotel_catalog,identity TO vayada_next_hotel_setup_logo_scope;
GRANT SELECT (id,kind,status) ON identity.organizations TO vayada_next_hotel_setup_logo_scope;
GRANT UPDATE (id) ON identity.organizations TO vayada_next_hotel_setup_logo_scope;
GRANT SELECT (organization_id,product,resource_type,resource_id,relationship,status) ON identity.organization_resource_links TO vayada_next_hotel_setup_logo_scope;
GRANT UPDATE (organization_id) ON identity.organization_resource_links TO vayada_next_hotel_setup_logo_scope;
GRANT SELECT (id,profile_revision,default_locale,profile_status) ON hotel_catalog.properties TO vayada_next_hotel_setup_logo_scope;
GRANT UPDATE (profile_revision,completeness_reasons,profile_status,updated_at) ON hotel_catalog.properties TO vayada_next_hotel_setup_logo_scope;
GRANT SELECT (property_id,locale,short_description,long_description) ON hotel_catalog.property_profiles TO vayada_next_hotel_setup_logo_scope;
GRANT SELECT (id,property_id,media_type,source_system,public_approved,platform_media_object_id,rights_metadata,alt_text,sort_order) ON hotel_catalog.property_media TO vayada_next_hotel_setup_logo_scope;
GRANT INSERT (property_id,media_type,url,alt_text,sort_order,source_system,public_approved,rights_metadata,platform_media_object_id,updated_at) ON hotel_catalog.property_media TO vayada_next_hotel_setup_logo_scope;
GRANT SELECT (id,upload_session_key,requested_purpose,requested_visibility,actor_user_id,owner_organization_id,property_id,resource_product,resource_type,resource_id,expected_content_type,expected_size_bytes,expected_file_count,staging_prefix,expires_at,session_status,completed_media_object_id,completion_metadata,created_at,updated_at,completed_at) ON platform.media_upload_sessions TO vayada_next_hotel_setup_logo_scope;
GRANT INSERT (id,upload_session_key,requested_purpose,requested_visibility,actor_user_id,owner_organization_id,property_id,resource_product,resource_type,resource_id,expected_content_type,expected_size_bytes,expected_file_count,staging_prefix,expires_at,session_status,completion_metadata,created_at,updated_at) ON platform.media_upload_sessions TO vayada_next_hotel_setup_logo_scope;
GRANT UPDATE (expires_at,session_status,completed_media_object_id,completion_metadata,completed_at,updated_at) ON platform.media_upload_sessions TO vayada_next_hotel_setup_logo_scope;
GRANT SELECT (id,bucket,storage_key,storage_kind,visibility,purpose,owner_organization_id,property_id,resource_product,resource_type,resource_id,lifecycle_status,content_type,size_bytes,checksum_sha256,width_px,height_px,original_filename,source_metadata,public_approved,retained_until,created_by_user_id,created_at,updated_at) ON platform.media_objects TO vayada_next_hotel_setup_logo_scope;
GRANT INSERT (id,bucket,storage_key,storage_kind,visibility,purpose,owner_organization_id,property_id,resource_product,resource_type,resource_id,lifecycle_status,content_type,size_bytes,checksum_sha256,width_px,height_px,original_filename,source_metadata,public_approved,retained_until,created_by_user_id,created_at,updated_at) ON platform.media_objects TO vayada_next_hotel_setup_logo_scope;
GRANT UPDATE (visibility,storage_key,lifecycle_status,public_approved,updated_at) ON platform.media_objects TO vayada_next_hotel_setup_logo_scope;
GRANT SELECT (id,media_object_id,variant_name,visibility,storage_key,content_type,width_px,height_px,size_bytes,checksum_sha256,public_cdn_url,created_at) ON platform.media_variants TO vayada_next_hotel_setup_logo_scope;
GRANT INSERT (media_object_id,variant_name,visibility,storage_key,content_type,width_px,height_px,size_bytes,checksum_sha256,public_cdn_url,created_at) ON platform.media_variants TO vayada_next_hotel_setup_logo_scope;
GRANT UPDATE (visibility,storage_key,public_cdn_url) ON platform.media_variants TO vayada_next_hotel_setup_logo_scope;
GRANT SELECT (id,property_id,tenant_scope,organization_id,operation_scope,operation,key_hash,request_fingerprint_hash,status,response_status_code,response_body_hash,idempotency_metadata,locked_until,response_resource_product,response_resource_type,response_resource_id) ON platform.idempotency_keys TO vayada_next_hotel_setup_logo_scope;
GRANT INSERT (operation_scope,operation,key_hash,request_fingerprint_hash,tenant_scope,property_id,correlation_id,expires_at,idempotency_metadata) ON platform.idempotency_keys TO vayada_next_hotel_setup_logo_scope;
GRANT UPDATE (status,response_status_code,response_body_hash,completed_at,last_seen_at,locked_until,idempotency_metadata) ON platform.idempotency_keys TO vayada_next_hotel_setup_logo_scope;
GRANT SELECT (id,job_key,queue_name,job_type,status,attempts_count,max_attempts,run_after,locked_at,locked_by,finished_at,tenant_scope,organization_id,property_id,resource_product,resource_type,resource_id,correlation_id,idempotency_key_hash,payload,job_metadata,created_at,updated_at) ON platform.jobs TO vayada_next_hotel_setup_logo_scope;
GRANT INSERT (job_key,queue_name,job_type,status,max_attempts,tenant_scope,property_id,resource_product,resource_type,resource_id,correlation_id,idempotency_key_hash,payload,job_metadata) ON platform.jobs TO vayada_next_hotel_setup_logo_scope;
GRANT UPDATE (status,attempts_count,run_after,locked_at,locked_by,finished_at,updated_at,job_metadata) ON platform.jobs TO vayada_next_hotel_setup_logo_scope;
GRANT SELECT (id,job_id,attempt_number,status,worker_id,started_at,finished_at,error_metadata) ON platform.job_attempts TO vayada_next_hotel_setup_logo_scope;
GRANT INSERT (job_id,attempt_number,status,worker_id,started_at,finished_at,error_type,error_message,error_metadata) ON platform.job_attempts TO vayada_next_hotel_setup_logo_scope;
GRANT UPDATE (status,worker_id,started_at,finished_at,duration_ms,error_type,error_message,retry_after,error_metadata) ON platform.job_attempts TO vayada_next_hotel_setup_logo_scope;
GRANT SELECT (source_kind,job_id,recovery_status) ON platform.dead_letter_events TO vayada_next_hotel_setup_logo_scope;
GRANT INSERT (source_kind,job_id,job_attempt_id,tenant_scope,property_id,resource_product,resource_type,resource_id,correlation_id,idempotency_key_hash,reason_code,failure_summary,failure_payload) ON platform.dead_letter_events TO vayada_next_hotel_setup_logo_scope;
GRANT SELECT (product,audit_key) ON platform.product_audit_events TO vayada_next_hotel_setup_logo_scope;
GRANT INSERT (audit_key,product,action,occurred_at,tenant_scope,organization_id,property_id,actor_type,actor_user_id,target_resource_product,target_resource_type,target_resource_id,job_id,idempotency_key_id,correlation_id,causation_id,redacted_payload,audit_metadata,retention_class,privacy_scope) ON platform.product_audit_events TO vayada_next_hotel_setup_logo_scope;
GRANT SELECT (priority) ON platform.jobs TO vayada_next_hotel_setup_logo_scope;
GRANT SELECT (private_artifact_manifest),UPDATE (private_artifact_manifest) ON platform.media_upload_sessions TO vayada_next_hotel_setup_logo_scope;
GRANT DELETE ON hotel_catalog.property_media TO vayada_next_hotel_setup_logo_scope;

-- Never let SET ROLE, a similarly named role or an inherited alias evade native scope.
CREATE FUNCTION platform.hotel_setup_logo_login_guard() RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT (session_user::text !~ '^vayada_next_hotel_setup_logo_'
   AND current_user::text !~ '^vayada_next_hotel_setup_logo_'
   AND NOT pg_has_role(session_user,'vayada_next_hotel_setup_logo_scope','MEMBER')
   AND NOT pg_has_role(current_user,'vayada_next_hotel_setup_logo_scope','MEMBER'))
   OR (current_user=session_user AND pg_has_role(session_user,'vayada_next_hotel_setup_logo_scope','USAGE'));
$$;
CREATE FUNCTION platform.hotel_setup_logo_context() RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE assignment RECORD;
BEGIN
 SELECT property_id,organization_id,actor_user_id INTO assignment
 FROM platform.hotel_setup_property_scopes WHERE database_login=session_user AND active AND operation_class='property_logo';
 IF NOT FOUND OR NOT platform.hotel_setup_logo_allowed(assignment.property_id,assignment.organization_id,assignment.actor_user_id)
 THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('property',assignment.property_id,'organization',assignment.organization_id,'actor',assignment.actor_user_id);
END $$;
-- Logo commands can advance the canonical status projection, never edit business fields.
CREATE FUNCTION platform.hotel_setup_logo_profile_revision_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE binding JSONB; reasons TEXT[]; expected_status TEXT;
BEGIN
 IF session_user::text !~ '^vayada_next_hotel_setup_logo_'
 AND (NOT pg_has_role(session_user,'vayada_next_hotel_setup_logo_scope','MEMBER')
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper)) THEN RETURN NEW; END IF;
 binding:=platform.hotel_setup_logo_context();
 IF OLD.id::text IS DISTINCT FROM binding->>'property' OR NEW.profile_revision<>OLD.profile_revision+1 THEN
 RAISE EXCEPTION 'logo profile revision scope mismatch' USING ERRCODE='42501'; END IF;
 reasons:=array_remove(ARRAY[
 CASE WHEN NOT EXISTS(SELECT 1 FROM hotel_catalog.property_profiles p WHERE p.property_id=OLD.id AND p.locale=OLD.default_locale
 AND COALESCE(NULLIF(btrim(p.short_description),''),NULLIF(btrim(p.long_description),'')) IS NOT NULL) THEN 'description' END,
 CASE WHEN NOT EXISTS(SELECT 1 FROM hotel_catalog.property_media assignment JOIN platform.media_objects m ON m.id=assignment.platform_media_object_id
 AND m.property_id=assignment.property_id AND m.visibility='public' AND m.public_approved AND m.lifecycle_status='active'
 JOIN platform.media_variants v ON v.media_object_id=m.id AND v.variant_name='original_safe' AND v.visibility='public'
 AND NULLIF(v.public_cdn_url,'') IS NOT NULL WHERE assignment.property_id=OLD.id AND assignment.public_approved AND assignment.source_system='platform') THEN 'media' END]::text[],NULL);
 expected_status:=CASE WHEN OLD.profile_status IN ('disabled','private') THEN OLD.profile_status
 WHEN cardinality(reasons)=0 THEN 'complete' ELSE 'incomplete' END;
 IF NEW.completeness_reasons IS DISTINCT FROM reasons OR NEW.profile_status IS DISTINCT FROM expected_status THEN
 RAISE EXCEPTION 'logo profile status must be canonical' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.hotel_setup_logo_profile_revision_guard() FROM PUBLIC;
CREATE TRIGGER hotel_setup_logo_profile_revision_guard BEFORE UPDATE ON hotel_catalog.properties
FOR EACH ROW EXECUTE FUNCTION platform.hotel_setup_logo_profile_revision_guard();
CREATE FUNCTION platform.hotel_setup_logo_property(requested UUID) RETURNS BOOLEAN
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT COALESCE(current_user=session_user AND requested::text=platform.hotel_setup_logo_context()->>'property',FALSE);
$$;
CREATE FUNCTION platform.hotel_setup_logo_organization(requested UUID) RETURNS BOOLEAN
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 SELECT COALESCE(current_user=session_user AND requested::text=platform.hotel_setup_logo_context()->>'organization',FALSE);
$$;

-- Boolean lookups run as the protected migration owner to avoid recursive RLS.
CREATE FUNCTION platform.hotel_setup_logo_media_upload_binding(requested UUID) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE binding JSONB := platform.hotel_setup_logo_context();
BEGIN
 RETURN EXISTS(SELECT 1 FROM platform.media_upload_sessions s WHERE s.property_id::text=binding->>'property'
 AND s.owner_organization_id::text=binding->>'organization' AND s.actor_user_id::text=binding->>'actor'
 AND s.requested_purpose='property.logo' AND s.requested_visibility='private' AND s.session_status IN ('signed','completed')
 AND s.completion_metadata->'session'->'files'->0->>'mediaId'=requested::text
 AND platform.hotel_setup_logo_session_binding(s.id,s.property_id,s.owner_organization_id,s.actor_user_id,s.completion_metadata->'session'));
END $$;
CREATE FUNCTION platform.hotel_setup_logo_media_read(requested UUID) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE binding JSONB := platform.hotel_setup_logo_context();
BEGIN
 RETURN COALESCE(EXISTS(SELECT 1 FROM platform.media_objects m WHERE m.id=requested
 AND m.property_id::text=binding->>'property' AND m.owner_organization_id::text=binding->>'organization'
 AND m.resource_product='hotel_catalog' AND m.resource_type='property' AND m.resource_id=m.property_id::text
 AND ((m.purpose='property.logo' AND m.created_by_user_id::text=binding->>'actor')
   OR (m.visibility='public' AND m.public_approved AND m.lifecycle_status='active'
     AND m.purpose IN ('property.logo','property.hero_image','property.gallery_image')))),FALSE);
END $$;
CREATE FUNCTION platform.hotel_setup_logo_job_read(requested UUID) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE binding JSONB := platform.hotel_setup_logo_context();
BEGIN
 RETURN COALESCE(EXISTS(SELECT 1 FROM platform.jobs j WHERE j.id=requested
 AND j.property_id::text=binding->>'property' AND j.tenant_scope='property' AND j.organization_id IS NULL
 AND j.queue_name='hotel-catalog.property-media' AND j.job_type='hotel-catalog.property-media.publish'
 AND j.resource_product='hotel_catalog' AND j.resource_type='property_media_assignment' AND j.resource_id=j.property_id::text
 AND j.payload->>'version'='2' AND j.payload->'command'->>'operation'='logo'
 AND j.payload->'command'->>'propertyId'=binding->>'property'
 AND j.payload->'command'->>'organizationId'=binding->>'organization'
 AND j.payload->'command'->>'actorUserId'=binding->>'actor'
 AND NOT (j.payload->'command' ? 'platformAdminHero')
 AND EXISTS(SELECT 1 FROM platform.idempotency_keys k WHERE k.id::text=j.payload->>'idempotencyId'
 AND k.property_id=j.property_id AND k.operation_scope='hotel_catalog' AND k.operation='hotel_catalog.property_media.logo.assign'
 AND k.idempotency_metadata->>'commandOrganizationId'=binding->>'organization'
 AND k.idempotency_metadata->>'commandActorUserId'=binding->>'actor')),FALSE);
END $$;
CREATE FUNCTION platform.hotel_setup_logo_safe_variant(
 media UUID,name TEXT,visibility TEXT,key TEXT,content_type TEXT,width INTEGER,height INTEGER,size BIGINT,checksum TEXT,url TEXT
) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(name IN ('original_safe','large','thumbnail','blur_preview') AND content_type='image/webp'
 AND width>0 AND height>0 AND size>0 AND checksum ~ '^[a-f0-9]{64}$'
 AND width<=CASE name WHEN 'original_safe' THEN 1920 WHEN 'large' THEN 1280 WHEN 'thumbnail' THEN 320 ELSE 32 END
 AND height<=CASE name WHEN 'original_safe' THEN 1920 WHEN 'large' THEN 720 WHEN 'thumbnail' THEN 180 ELSE 18 END
 AND ((visibility='private' AND url IS NULL AND key='private/media/'||media::text||'/'||name||'/sha256-'||checksum||'.webp')
 OR (visibility='public' AND url='https://images.vayada.com/'||substring(key FROM 8) AND key ~ ('^public/media/'||media::text||'/'||name||'/publication-[a-f0-9-]{36}\.webp$')
   AND right(url,length(key)-7)=substring(key FROM 8))),FALSE);
$$;
CREATE FUNCTION platform.hotel_setup_logo_manifest_valid(metadata JSONB,manifest JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE item JSONB; media UUID;
BEGIN
 IF jsonb_typeof(manifest) IS DISTINCT FROM 'array' OR jsonb_array_length(manifest)>4 THEN RETURN FALSE; END IF;
 IF (metadata->'session'->'files'->0->>'mediaId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') IS DISTINCT FROM TRUE THEN RETURN FALSE; END IF;
 media := (metadata->'session'->'files'->0->>'mediaId')::uuid;
 FOR item IN SELECT value FROM jsonb_array_elements(manifest) LOOP
 IF item->>'mediaId' IS DISTINCT FROM media::text
 OR (item->>'widthPx' ~ '^[0-9]{1,4}$') IS DISTINCT FROM TRUE OR (item->>'heightPx' ~ '^[0-9]{1,4}$') IS DISTINCT FROM TRUE
 OR (item->>'sizeBytes' ~ '^[0-9]{1,9}$') IS DISTINCT FROM TRUE
 OR item->'publicCdnUrl' IS DISTINCT FROM 'null'::jsonb
 OR NOT platform.hotel_setup_logo_safe_variant(media,item->>'variantName',item->>'visibility',item->>'storageKey',item->>'contentType',
 (item->>'widthPx')::integer,(item->>'heightPx')::integer,(item->>'sizeBytes')::bigint,item->>'checksumSha256',NULL)
 THEN RETURN FALSE; END IF;
 END LOOP;
 RETURN (SELECT count(DISTINCT value->>'variantName')=jsonb_array_length(manifest) FROM jsonb_array_elements(manifest));
END $$;
CREATE FUNCTION platform.hotel_setup_logo_session_valid(
 session_id UUID,property UUID,organization UUID,actor UUID,status TEXT,completed UUID,metadata JSONB
) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s JSONB := metadata->'session'; f JSONB; snapshot JSONB; v JSONB; registry RECORD;
BEGIN
 IF NOT platform.hotel_setup_logo_allowed(property,organization,actor)
 OR NOT platform.hotel_setup_logo_session_binding(session_id,property,organization,actor,s)
 OR s->>'status' IS DISTINCT FROM status OR jsonb_typeof(s->'files') IS DISTINCT FROM 'array'
 OR jsonb_array_length(s->'files')<>1 OR jsonb_typeof(s->'uploadTargets') IS DISTINCT FROM 'array'
 OR jsonb_array_length(s->'uploadTargets')<>1 THEN RETURN FALSE; END IF;
 f := s->'files'->0;
 IF (f->>'mediaId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') IS DISTINCT FROM TRUE
 OR (f->>'uploadTargetId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') IS DISTINCT FROM TRUE
 OR f->>'uploadTargetId' IS DISTINCT FROM s->'uploadTargets'->0->>'uploadTargetId'
 OR (s->'uploadTargets'->0->>'stagingKey' LIKE 'staging/'||session_id::text||'/%') IS DISTINCT FROM TRUE
 OR s->'uploadTargets'->0->>'stagingKey' ~ '(^|/)\.\.?(/|$)'
 OR s->'uploadTargets'->0->>'stagingKey' LIKE '%//%'
 OR octet_length(s->'uploadTargets'->0->>'stagingKey')>1024
 OR s->'uploadTargets'->0->>'uploadUrl' IS DISTINCT FROM '' OR s->'uploadTargets'->0->'headers' IS DISTINCT FROM '{}'::jsonb
 THEN RETURN FALSE; END IF;
 IF status='signed' THEN
 RETURN completed IS NULL AND NOT(s ? 'completedMediaObject') AND NOT(s ? 'completedMediaObjects') AND NOT(metadata ? 'mediaObjectIds');
 END IF;
 IF status<>'completed' OR completed::text IS DISTINCT FROM f->>'mediaId'
 OR metadata->'mediaObjectIds' IS DISTINCT FROM jsonb_build_array(completed::text)
 OR jsonb_typeof(s->'completedMediaObjects') IS DISTINCT FROM 'array'
 OR jsonb_array_length(s->'completedMediaObjects')<>1
 OR s->'completedMediaObject' IS DISTINCT FROM s->'completedMediaObjects'->0 THEN RETURN FALSE; END IF;
 snapshot := s->'completedMediaObjects'->0;
 SELECT * INTO registry FROM platform.media_objects WHERE id=completed AND property_id=property
 AND owner_organization_id=organization AND created_by_user_id=actor AND purpose='property.logo';
 IF NOT FOUND OR snapshot->>'mediaId' IS DISTINCT FROM completed::text
 OR snapshot->>'actorUserId' IS DISTINCT FROM actor::text OR snapshot->>'ownerOrganizationId' IS DISTINCT FROM organization::text
 OR snapshot->>'propertyId' IS DISTINCT FROM property::text OR snapshot->>'resourceId' IS DISTINCT FROM property::text
 OR snapshot->>'resourceProduct' IS DISTINCT FROM 'hotel_catalog' OR snapshot->>'resourceType' IS DISTINCT FROM 'property'
 OR snapshot->>'purpose' IS DISTINCT FROM 'property.logo' OR snapshot->>'visibility' IS DISTINCT FROM 'private'
 OR snapshot->>'requestedVisibility' IS DISTINCT FROM 'private' OR snapshot->>'approvalStatus' IS DISTINCT FROM 'private'
 OR snapshot->>'lifecycleStatus' IS DISTINCT FROM 'staged' OR snapshot->>'storageKind' IS DISTINCT FROM 'vayada_managed'
 OR snapshot->>'contentType' IS DISTINCT FROM registry.content_type OR snapshot->>'sizeBytes' IS DISTINCT FROM registry.size_bytes::text
 OR snapshot->>'widthPx' IS DISTINCT FROM registry.width_px::text OR snapshot->>'heightPx' IS DISTINCT FROM registry.height_px::text
 OR snapshot->>'bucket' IS DISTINCT FROM registry.bucket OR snapshot->>'checksumSha256' IS DISTINCT FROM registry.checksum_sha256
 OR snapshot->>'storageKey' IS DISTINCT FROM 'private/media/'||completed::text||'/original_safe/sha256-'||registry.checksum_sha256||'.webp'
 OR jsonb_typeof(snapshot->'variants') IS DISTINCT FROM 'array' OR jsonb_array_length(snapshot->'variants')<>4
 THEN RETURN FALSE; END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(snapshot->'variants') LOOP
 IF NOT EXISTS(SELECT 1 FROM platform.media_variants mv WHERE mv.media_object_id=completed AND mv.variant_name=v->>'variantName'
 AND mv.checksum_sha256=v->>'checksumSha256' AND mv.width_px::text=v->>'widthPx' AND mv.height_px::text=v->>'heightPx'
 AND mv.size_bytes::text=v->>'sizeBytes' AND platform.hotel_setup_logo_safe_variant(completed,mv.variant_name,
 v->>'visibility',v->>'storageKey',v->>'contentType',mv.width_px,mv.height_px,mv.size_bytes,mv.checksum_sha256,NULLIF(v->>'publicCdnUrl','')))
 THEN RETURN FALSE; END IF;
 END LOOP;
 RETURN (SELECT count(DISTINCT value->>'variantName')=4 FROM jsonb_array_elements(snapshot->'variants'));
END $$;
CREATE FUNCTION platform.hotel_setup_logo_job_valid(property UUID,payload JSONB) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE binding JSONB := platform.hotel_setup_logo_context(); item JSONB; promotion JSONB; m RECORD; v RECORD;
BEGIN
 IF property::text IS DISTINCT FROM binding->>'property' OR payload->>'version' IS DISTINCT FROM '2'
 OR payload->'command'->>'operation' IS DISTINCT FROM 'logo'
 OR payload->'command'->>'propertyId' IS DISTINCT FROM binding->>'property'
 OR payload->'command'->>'organizationId' IS DISTINCT FROM binding->>'organization'
 OR payload->'command'->>'actorUserId' IS DISTINCT FROM binding->>'actor'
 OR payload->'command' ? 'platformAdminHero'
 OR jsonb_typeof(payload->'command'->'assignments') IS DISTINCT FROM 'array'
 OR jsonb_array_length(payload->'command'->'assignments')<>1
 OR payload->'command'->'assignments'->0->>'role' IS DISTINCT FROM 'logo'
 OR jsonb_typeof(payload->'media') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'media')<>1
 OR (payload->>'publicationToken' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') IS DISTINCT FROM TRUE
 OR NOT EXISTS(SELECT 1 FROM platform.idempotency_keys k WHERE k.id::text=payload->>'idempotencyId'
 AND k.property_id=property AND k.operation='hotel_catalog.property_media.logo.assign'
 AND k.idempotency_metadata->>'commandActorUserId'=binding->>'actor'
 AND k.idempotency_metadata->>'commandOrganizationId'=binding->>'organization'
 AND k.key_hash=payload->>'keyHash' AND k.request_fingerprint_hash=payload->>'requestFingerprintHash') THEN RETURN FALSE; END IF;
 item:=payload->'media'->0;
 IF item->>'mediaObjectId' IS DISTINCT FROM payload->'command'->'assignments'->0->>'mediaObjectId' THEN RETURN FALSE; END IF;
 SELECT * INTO m FROM platform.media_objects WHERE id::text=item->>'mediaObjectId'
 AND property_id=property AND owner_organization_id::text=binding->>'organization'
 AND (purpose='property.logo' OR (visibility='public' AND public_approved AND lifecycle_status='active'));
 IF NOT FOUND OR jsonb_typeof(item->'promotion') IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
 IF jsonb_array_length(item->'promotion')=0 THEN
 RETURN m.visibility='public' AND m.public_approved AND EXISTS(SELECT 1 FROM platform.media_variants mv
 WHERE mv.media_object_id=m.id AND mv.variant_name='original_safe' AND mv.public_cdn_url=item->>'originalSafeUrl');
 END IF;
 IF jsonb_array_length(item->'promotion')<>4 OR m.purpose<>'property.logo'
 OR NOT platform.hotel_setup_logo_media_upload_binding(m.id) OR m.created_by_user_id::text IS DISTINCT FROM binding->>'actor' THEN RETURN FALSE; END IF;
 FOR promotion IN SELECT value FROM jsonb_array_elements(item->'promotion') LOOP
 SELECT * INTO v FROM platform.media_variants WHERE media_object_id=m.id AND variant_name=promotion->>'variantName';
 IF NOT FOUND OR promotion->>'contentType' IS DISTINCT FROM 'image/webp'
 OR promotion->>'privateStorageKey' IS DISTINCT FROM 'private/media/'||m.id::text||'/'||v.variant_name||'/sha256-'||v.checksum_sha256||'.webp'
 OR promotion->>'publicStorageKey' IS DISTINCT FROM 'public/media/'||m.id::text||'/'||v.variant_name||'/publication-'||(payload->>'publicationToken')||'.webp'
 OR promotion->>'publicUrl' IS DISTINCT FROM 'https://images.vayada.com/'||substring(promotion->>'publicStorageKey' FROM 8)
 OR right(promotion->>'publicUrl',length(promotion->>'publicStorageKey')-7) IS DISTINCT FROM substring(promotion->>'publicStorageKey' FROM 8)
 THEN RETURN FALSE; END IF;
 END LOOP;
 RETURN (SELECT count(DISTINCT value->>'variantName')=4 FROM jsonb_array_elements(item->'promotion'))
 AND item->>'originalSafeUrl'=(SELECT value->>'publicUrl' FROM jsonb_array_elements(item->'promotion') WHERE value->>'variantName'='original_safe');
END $$;
CREATE FUNCTION platform.hotel_setup_logo_public_key(media UUID,name TEXT,key TEXT,url TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 RETURN EXISTS(SELECT 1 FROM platform.jobs j,LATERAL jsonb_array_elements(j.payload->'media') item,
 LATERAL jsonb_array_elements(item->'promotion') promotion
 WHERE platform.hotel_setup_logo_job_read(j.id) AND j.status='running'
 AND item->>'mediaObjectId'=media::text AND promotion->>'variantName'=name
 AND promotion->>'publicStorageKey'=key AND (url IS NULL OR promotion->>'publicUrl'=url));
END $$;

DO $$
DECLARE item RECORD; non_logo TEXT := $guard$
 session_user::text !~ '^vayada_next_hotel_setup_logo_' AND current_user::text !~ '^vayada_next_hotel_setup_logo_'
 AND NOT pg_has_role(session_user,'vayada_next_hotel_setup_logo_scope','MEMBER')
 AND NOT pg_has_role(current_user,'vayada_next_hotel_setup_logo_scope','MEMBER')
$guard$;
BEGIN
 FOR item IN SELECT * FROM (VALUES
 ('identity.organizations','platform.hotel_setup_logo_organization(id)',NULL::TEXT,NULL::TEXT,FALSE),
 ('identity.organization_resource_links',$p$platform.hotel_setup_logo_organization(organization_id)
 AND product='hotel_catalog' AND resource_type='property' AND relationship='owner' AND status='active'
 AND resource_id=platform.hotel_setup_logo_context()->>'property'$p$,NULL,NULL,FALSE),
 ('hotel_catalog.properties','platform.hotel_setup_logo_property(id)',NULL,'platform.hotel_setup_logo_property(id)',FALSE),
 ('hotel_catalog.property_profiles','platform.hotel_setup_logo_property(property_id)',NULL,NULL,FALSE),
 ('hotel_catalog.property_media','platform.hotel_setup_logo_property(property_id)',$p$
 platform.hotel_setup_logo_property(property_id) AND media_type='logo' AND source_system='platform'
 AND platform.hotel_setup_logo_media_read(platform_media_object_id)
 AND rights_metadata->>'platformMediaObjectId'=platform_media_object_id::text
 AND ((public_approved AND EXISTS(SELECT 1 FROM platform.media_variants mv WHERE mv.media_object_id=platform_media_object_id
 AND mv.variant_name='original_safe' AND mv.visibility='public' AND mv.public_cdn_url=url))
 OR (NOT public_approved AND url='urn:vayada:platform-media:'||platform_media_object_id::text
 AND rights_metadata->>'publicationState'='pending' AND EXISTS(SELECT 1 FROM platform.jobs j
 WHERE j.id::text=rights_metadata->>'publicationJobId' AND platform.hotel_setup_logo_job_read(j.id))))$p$,NULL,TRUE),
 ('platform.media_upload_sessions',$p$platform.hotel_setup_logo_row_allowed(property_id,owner_organization_id,actor_user_id)
 AND requested_purpose='property.logo' AND requested_visibility='private' AND resource_product='hotel_catalog'
 AND resource_type='property' AND resource_id=property_id::text AND staging_prefix='staging/'||id::text
 AND completion_metadata->'session'->>'uploadSessionKey'=upload_session_key AND expected_file_count=1
 AND completion_metadata->'session'->'files'->0->>'contentType'=expected_content_type
 AND completion_metadata->'session'->'files'->0->>'sizeBytes'=expected_size_bytes::text
 AND platform.hotel_setup_logo_session_valid(id,property_id,owner_organization_id,actor_user_id,session_status,completed_media_object_id,completion_metadata)
 AND platform.hotel_setup_logo_manifest_valid(completion_metadata,private_artifact_manifest)$p$,
 'same','same',FALSE),
 ('platform.media_objects','platform.hotel_setup_logo_media_read(id)',$p$
 platform.hotel_setup_logo_row_allowed(property_id,owner_organization_id,created_by_user_id)
 AND platform.hotel_setup_logo_media_upload_binding(id) AND bucket='vayada-media-production' AND purpose='property.logo' AND storage_kind='vayada_managed' AND visibility='private' AND lifecycle_status='staged'
 AND NOT public_approved AND resource_product='hotel_catalog' AND resource_type='property' AND resource_id=property_id::text
 AND source_metadata='{"requestedVisibility":"private"}'::jsonb AND retained_until IS NULL
 AND platform.hotel_setup_logo_safe_variant(id,'original_safe',visibility,storage_key,content_type,width_px,height_px,size_bytes,checksum_sha256,NULL)$p$,$p$
 platform.hotel_setup_logo_row_allowed(property_id,owner_organization_id,created_by_user_id)
 AND purpose='property.logo' AND visibility='public' AND lifecycle_status='active' AND public_approved
 AND platform.hotel_setup_logo_public_key(id,'original_safe',storage_key,NULL)$p$,FALSE),
 ('platform.media_variants','platform.hotel_setup_logo_media_read(media_object_id)',$p$
 platform.hotel_setup_logo_media_read(media_object_id) AND platform.hotel_setup_logo_media_upload_binding(media_object_id) AND visibility='private'
 AND platform.hotel_setup_logo_safe_variant(media_object_id,variant_name,visibility,storage_key,content_type,width_px,height_px,size_bytes,checksum_sha256,public_cdn_url)$p$,$p$
 platform.hotel_setup_logo_media_read(media_object_id) AND visibility='public'
 AND EXISTS(SELECT 1 FROM platform.media_objects m WHERE m.id=media_object_id AND m.purpose='property.logo'
 AND m.created_by_user_id::text=platform.hotel_setup_logo_context()->>'actor')
 AND platform.hotel_setup_logo_safe_variant(media_object_id,variant_name,visibility,storage_key,content_type,width_px,height_px,size_bytes,checksum_sha256,public_cdn_url)
 AND platform.hotel_setup_logo_public_key(media_object_id,variant_name,storage_key,public_cdn_url)$p$,FALSE),
 ('platform.idempotency_keys',$p$platform.hotel_setup_logo_property(property_id) AND tenant_scope='property' AND organization_id IS NULL
 AND operation_scope='hotel_catalog' AND operation='hotel_catalog.property_media.logo.assign'
 AND idempotency_metadata->>'commandActorUserId'=platform.hotel_setup_logo_context()->>'actor'
 AND idempotency_metadata->>'commandOrganizationId'=platform.hotel_setup_logo_context()->>'organization'$p$,'same','same',FALSE),
 ('platform.jobs',$p$platform.hotel_setup_logo_property(property_id) AND tenant_scope='property' AND organization_id IS NULL
 AND queue_name='hotel-catalog.property-media' AND job_type='hotel-catalog.property-media.publish'
 AND resource_product='hotel_catalog' AND resource_type='property_media_assignment' AND resource_id=property_id::text
 AND job_key=property_id::text||':hotel_catalog.property_media.logo.assign:'||idempotency_key_hash
 AND payload->>'keyHash'=idempotency_key_hash AND max_attempts=8
 AND job_metadata->>'publicationVersion'='2' AND jsonb_typeof(job_metadata->'cleanupRequired')='boolean'
 AND job_metadata->'cleanupKeys'=(SELECT jsonb_agg(p->>'publicStorageKey' ORDER BY p->>'publicStorageKey')
 FROM jsonb_array_elements(payload->'media') m,LATERAL jsonb_array_elements(m->'promotion') p)
 AND platform.hotel_setup_logo_job_valid(property_id,payload)$p$,'same','same',FALSE),
 ('platform.job_attempts','platform.hotel_setup_logo_job_read(job_id)','same','same',FALSE),
 ('platform.dead_letter_events',$p$source_kind='job' AND tenant_scope='property' AND organization_id IS NULL
 AND platform.hotel_setup_logo_property(property_id) AND resource_product='hotel_catalog'
 AND resource_type='property_media_assignment' AND resource_id=property_id::text
 AND platform.hotel_setup_logo_job_read(job_id)
 AND EXISTS(SELECT 1 FROM platform.jobs j WHERE j.id=job_id AND j.idempotency_key_hash=dead_letter_events.idempotency_key_hash)
 AND EXISTS(SELECT 1 FROM platform.job_attempts a WHERE a.id=job_attempt_id AND a.job_id=dead_letter_events.job_id)$p$,'same',NULL,FALSE),
 ('platform.product_audit_events','same',$p$
 ((product='platform' AND job_id IS NULL AND idempotency_key_id IS NULL AND tenant_scope='organization' AND property_id IS NULL AND actor_type='user'
 AND platform.hotel_setup_logo_organization(organization_id) AND actor_user_id::text=platform.hotel_setup_logo_context()->>'actor'
 AND target_resource_product='platform'
 AND ((action='platform_media.upload_session.created' AND target_resource_type='media_upload_session'
 AND EXISTS(SELECT 1 FROM platform.media_upload_sessions s WHERE s.id::text=target_resource_id))
 OR (action='platform_media.upload_session.finalized' AND target_resource_type='media_object'
 AND EXISTS(SELECT 1 FROM platform.media_objects m WHERE m.id::text=target_resource_id AND platform.hotel_setup_logo_media_read(m.id)))))
 OR (product='hotel_catalog' AND tenant_scope='property' AND organization_id IS NULL AND platform.hotel_setup_logo_property(property_id)
 AND actor_type='user' AND actor_user_id::text=platform.hotel_setup_logo_context()->>'actor'
 AND action IN ('property.media.publication.accepted','property.media.logo.assigned','property.media.command.rejected')
 AND target_resource_product='hotel_catalog' AND target_resource_type='property' AND target_resource_id=property_id::text
 AND (job_id IS NULL OR platform.hotel_setup_logo_job_read(job_id))
 AND EXISTS(SELECT 1 FROM platform.idempotency_keys k WHERE k.id=idempotency_key_id)))$p$,NULL,FALSE)
 ) scope(relation,read_predicate,insert_predicate,update_predicate,delete_allowed) LOOP
 IF item.read_predicate='same' THEN item.read_predicate:=item.insert_predicate; END IF;
 IF NOT(SELECT relrowsecurity FROM pg_class WHERE oid=item.relation::regclass) THEN
 EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',item.relation);
 EXECUTE format('CREATE POLICY hotel_setup_logo_existing_callers ON %s TO PUBLIC USING (true) WITH CHECK(true)',item.relation);
 END IF;
 EXECUTE format('CREATE POLICY hotel_setup_logo_guard ON %s AS RESTRICTIVE TO PUBLIC USING(platform.hotel_setup_logo_login_guard()) WITH CHECK(platform.hotel_setup_logo_login_guard())',item.relation);
 -- Explicit permission for already-scoped tables; restrictive policies keep every row bounded.
 EXECUTE format('CREATE POLICY hotel_setup_logo_access ON %s TO vayada_next_hotel_setup_logo_scope USING(true) WITH CHECK(true)',item.relation);
 EXECUTE format('CREATE POLICY hotel_setup_logo_read ON %s AS RESTRICTIVE FOR SELECT TO vayada_next_hotel_setup_logo_scope USING(%s)',item.relation,item.read_predicate);
 IF item.insert_predicate='same' THEN item.insert_predicate:=item.read_predicate; END IF;
 IF item.update_predicate='same' THEN item.update_predicate:=item.read_predicate; END IF;
 EXECUTE format('CREATE POLICY hotel_setup_logo_insert ON %s AS RESTRICTIVE FOR INSERT TO vayada_next_hotel_setup_logo_scope WITH CHECK(%s)',item.relation,COALESCE(item.insert_predicate,'FALSE'));
 EXECUTE format('CREATE POLICY hotel_setup_logo_update ON %s AS RESTRICTIVE FOR UPDATE TO vayada_next_hotel_setup_logo_scope USING(%s) WITH CHECK(%s)',item.relation,item.read_predicate,COALESCE(item.update_predicate,'FALSE'));
 EXECUTE format('CREATE POLICY hotel_setup_logo_delete ON %s AS RESTRICTIVE FOR DELETE TO vayada_next_hotel_setup_logo_scope USING(%s)',item.relation,
 CASE WHEN item.delete_allowed THEN 'platform.hotel_setup_logo_property(property_id) AND media_type=''logo''' ELSE 'FALSE' END);
 END LOOP;
END $$;

DO $$ DECLARE p RECORD; BEGIN
 FOR p IN SELECT oid FROM pg_proc WHERE pronamespace='platform'::regnamespace AND proname LIKE 'hotel_setup_logo_%' AND proname NOT IN ('hotel_setup_logo_authority','hotel_setup_logo_profile_revision_guard') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',p.oid::regprocedure);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO vayada_next_hotel_setup_logo_scope',p.oid::regprocedure);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_logo_login_guard() TO PUBLIC;
GRANT EXECUTE ON FUNCTION platform.tenant_scope_key(TEXT,UUID,UUID),platform.valid_tenant_scope(TEXT,UUID,UUID),
 platform.valid_media_purpose_visibility(TEXT,TEXT),platform.hotel_setup_reader_audit_allowed(platform.product_audit_events),
 platform.channex_management_worker_source(TEXT,TEXT,UUID),platform.channex_management_worker_scope(TEXT,TEXT,UUID),
 platform.finance_expense_worker_scope(TEXT,TEXT,UUID),platform.finance_export_worker_scope(TEXT,TEXT,UUID)
 TO vayada_next_hotel_setup_logo_scope;
