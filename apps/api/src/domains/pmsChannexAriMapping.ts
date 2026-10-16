// Shared predicates for queries with canonical inventory and Channex connection aliases.
export const CHANNEX_ARI_ACTIVE_ROOM_SQL = `EXISTS (SELECT 1 FROM pms.room_types room
  WHERE room.id = inventory.room_type_id AND room.property_id = inventory.property_id AND room.active
    AND NOT EXISTS (SELECT 1 FROM pms.room_type_closures closure
      WHERE closure.property_id=room.property_id AND closure.room_type_id=room.id))`;
// A published offer target on the current binding is the room's shared base rate (VAY-2036).
const CHANNEX_ARI_ACTIVE_OFFER_SQL = `EXISTS (SELECT 1 FROM pms.channex_offer_targets target
    JOIN pms.channex_offer_target_versions version
      ON version.target_id = target.id AND version.version = target.active_version
    JOIN pms.channel_room_type_mappings room_mapping
      ON room_mapping.connection_id = connection.id AND room_mapping.room_type_id = target.room_type_id
     AND room_mapping.status = 'active'
     AND room_mapping.external_room_type_id = version.external_room_type_id
    WHERE target.connection_id = connection.id AND target.room_type_id = inventory.room_type_id
      AND version.binding_generation = connection.binding_generation
      AND version.external_property_id = connection.external_property_id)`;
// A room syncs through any active rate mapping or its published offer. Imported hotels keep one
// rate plan per legacy channel mapping beside unmapped LEGACY-* plans, and OTAs without their own
// variant sell the shared base rate, so nothing is required per rate plan or channel (VAY-2206).
export const CHANNEX_ARI_MAPPING_MISSING_SQL = `(${CHANNEX_ARI_ACTIVE_ROOM_SQL} AND (
  NOT EXISTS (SELECT 1 FROM pms.channel_room_type_mappings mapping
    WHERE mapping.connection_id = connection.id
      AND mapping.room_type_id = inventory.room_type_id AND mapping.status = 'active')
  OR (NOT EXISTS (SELECT 1 FROM pms.channel_rate_plan_mappings mapping
    WHERE mapping.connection_id = connection.id
      AND mapping.room_type_id = inventory.room_type_id AND mapping.status = 'active')
    AND NOT ${CHANNEX_ARI_ACTIVE_OFFER_SQL})
))`;
