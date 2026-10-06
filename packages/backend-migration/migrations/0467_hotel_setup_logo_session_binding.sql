-- VAY-965: pure binding predicate for the native logo session policies.
-- This does not grant media access or admit a serving writer.
CREATE FUNCTION platform.hotel_setup_logo_session_binding(
  session_id UUID, property_id UUID, organization_id UUID, actor_id UUID,
  session_metadata JSONB
) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path=pg_catalog AS $$
  SELECT COALESCE(
    session_metadata->>'sessionId'=session_id::text
    AND session_metadata->>'purpose'='property.logo'
    AND session_metadata->>'actorUserId'=actor_id::text
    AND session_metadata->>'ownerOrganizationId'=organization_id::text
    AND session_metadata->>'requestedVisibility'='private'
    AND session_metadata->>'effectiveVisibility'='private'
    AND NOT (session_metadata ? 'platformAdmin')
    AND session_metadata->'resource'->>'product'='hotel_catalog'
    AND session_metadata->'resource'->>'resourceType'='property'
    AND session_metadata->'resource'->>'resourceId'=property_id::text
    AND (NOT (session_metadata->'resource' ? 'propertyId')
      OR session_metadata->'resource'->>'propertyId'=property_id::text)
    AND NOT (session_metadata->'resource' ? 'targetResourceId')
    AND session_metadata->'target'=jsonb_build_object(
      'resourceProduct','hotel_catalog','resourceType','property',
      'resourceId',property_id::text,'propertyId',property_id::text)
    AND session_metadata->>'stagingPrefix'='staging/'||session_id::text,
    FALSE);
$$;
REVOKE ALL ON FUNCTION platform.hotel_setup_logo_session_binding(UUID,UUID,UUID,UUID,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.hotel_setup_logo_session_binding(UUID,UUID,UUID,UUID,JSONB)
  TO vayada_next_hotel_setup_logo_scope;
