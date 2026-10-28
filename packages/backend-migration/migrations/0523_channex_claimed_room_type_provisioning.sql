-- VAY-2108 D7b: room-type provisioning for claimed hotels (engineering/channex-per-hotel-ownership.md).
-- A hotel that pressed "Enable connection" has no Channex room types yet. The claimed worker may
-- now claim its plain provisioning job (room types only: no published offer, no meal plan) and
-- record each created room type as an active mapping. 0408's lock-only policy on the mapping
-- table stays, so the worker still cannot edit or retarget a mapping; the pinned helpers stay
-- byte-identical and every other policy branch is unchanged.
SET LOCAL lock_timeout = '5s';

-- Queue rows: the claimed branch gains the plain provisioning shape. Like 0519 it admits by
-- operation, never by property; the plan reads the hotel's rooms and binding through the claim,
-- so a job for a hotel the target does not own fails closed.
ALTER POLICY channex_management_worker_scope ON platform.jobs
  USING (current_user <> 'vayada_next_channex_management_worker' OR (
    tenant_scope = 'property'
    AND queue_name = 'pms.channex.management'
    AND resource_product = 'pms' AND resource_type = 'channex_connection'
    AND resource_id = property_id::text
    AND NOT (payload ?| ARRAY['recoveryAlertId','mealRatePlanId','markups','inventoryRules','restrictions'])
    AND ((platform.channex_management_worker_scope('property', property_id::text)
        AND ((job_type = 'channex.sync_ari' AND payload->>'operationType' = 'sync_ari')
          OR (job_type = 'channex.provision' AND payload->>'operationType' = 'provision'
            AND jsonb_typeof(payload->'publishedOffer') = 'object')))
      OR (job_type = 'channex.sync_ari' AND payload->>'operationType' = 'sync_ari'
        AND platform.channex_management_worker_claimed_scope('operation', 'sync_ari'))
      OR (job_type = 'channex.provision' AND payload->>'operationType' = 'provision'
        AND (jsonb_typeof(payload->'publishedOffer') = 'object' OR NOT payload ? 'publishedOffer')
        AND platform.channex_management_worker_claimed_scope('operation', 'provision'))
      OR (platform.channex_management_worker_connection_scope('operation', 'enable')
        AND job_type = 'channex.enable' AND payload->>'operationType' = 'enable'))
  ));

-- A new mapping: an active row for an owned hotel's active room, on the hotel's connected
-- Channex connection, with nothing but the provider's room type id. The 0408 scope policy
-- (worker_source 'connection') also checks the row, and the platform's claimed grant mode
-- gives the INSERT (property_id, connection_id, room_type_id, external_room_type_id, status).
CREATE POLICY channex_management_worker_insert ON pms.channel_room_type_mappings
  AS RESTRICTIVE FOR INSERT TO PUBLIC
  WITH CHECK (current_user <> 'vayada_next_channex_management_worker'
    OR (status = 'active' AND mapping_metadata = '{}'::jsonb
      AND platform.channex_management_worker_claimed_scope('operation', 'provision')
      AND platform.channex_management_worker_claimed_scope('property', property_id::text)
      AND EXISTS (SELECT 1 FROM pms.channel_connections connection
        WHERE connection.id = connection_id AND connection.property_id = channel_room_type_mappings.property_id
          AND connection.provider = 'channex' AND connection.connection_status IN ('connected', 'degraded'))
      AND EXISTS (SELECT 1 FROM pms.room_types room
        WHERE room.id = room_type_id AND room.property_id = channel_room_type_mappings.property_id
          AND room.active)));
