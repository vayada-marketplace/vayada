// Shared predicates for queries with canonical inventory and Channex connection aliases.
// Freeze legacy requirements before discovery replaces the connected-channel cache.
export const CHANNEX_MANAGED_RATE_CHANNELS_SQL = `COALESCE(
  connection.connection_metadata->'managedRateChannels',
  (SELECT COALESCE(jsonb_agg(connected.value->>'key'), '[]'::jsonb)
   FROM jsonb_array_elements(
     CASE WHEN jsonb_typeof(connection.connection_metadata->'connectedChannels') = 'array'
       THEN connection.connection_metadata->'connectedChannels' ELSE '[]'::jsonb END
   ) AS connected(value)
   WHERE connected.value->>'isActive' = 'true' AND connected.value->>'key' IS NOT NULL)
)`;
export const CHANNEX_ARI_ACTIVE_ROOM_SQL = `EXISTS (SELECT 1 FROM pms.room_types room
  WHERE room.id = inventory.room_type_id AND room.property_id = inventory.property_id AND room.active)`;
export const CHANNEX_ARI_MAPPING_MISSING_SQL = `(${CHANNEX_ARI_ACTIVE_ROOM_SQL} AND (
  NOT EXISTS (SELECT 1 FROM pms.channel_room_type_mappings mapping
    WHERE mapping.connection_id = connection.id
      AND mapping.room_type_id = inventory.room_type_id AND mapping.status = 'active')
  OR NOT EXISTS (SELECT 1 FROM pms.channel_rate_plan_mappings mapping
    WHERE mapping.connection_id = connection.id
      AND mapping.room_type_id = inventory.room_type_id AND mapping.status = 'active')
  OR EXISTS (
    SELECT 1 FROM pms.rate_plans canonical_rate
    CROSS JOIN LATERAL (
      SELECT channel FROM pms.channel_rate_plan_mappings known
      WHERE known.connection_id = connection.id
      UNION
      SELECT value FROM jsonb_array_elements_text(${CHANNEX_MANAGED_RATE_CHANNELS_SQL})
    ) expected
    WHERE canonical_rate.property_id = inventory.property_id
      AND canonical_rate.room_type_id = inventory.room_type_id AND canonical_rate.active
      AND NOT EXISTS (SELECT 1 FROM pms.channel_rate_plan_mappings mapping
        WHERE mapping.connection_id = connection.id AND mapping.rate_plan_id = canonical_rate.id
          AND mapping.channel = expected.channel AND mapping.status = 'active')
  )
))`;
