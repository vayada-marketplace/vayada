import type { PoolClient } from "pg";

/** Only the guarded staging repair supplies this capability, under its locks. */
export async function resolveStagingCatalogReference(
  client: PoolClient,
  scope: {
    propertyId: string;
    connectionId: string;
    bindingGeneration: string;
    bookingId: string;
    providerBookingId: string;
    revisionId: string;
    externalRoomTypeId: string;
    externalRatePlanId: string;
  },
) {
  return (
    await client.query<{ roomTypeId: string; ratePlanId: null; stagingCatalogReferenceId: string }>(
      `SELECT r.id::text AS "roomTypeId",NULL::text AS "ratePlanId",ref.id::text AS "stagingCatalogReferenceId"
     FROM pms.channex_staging_catalog_references ref
     JOIN pms.channel_connections c ON c.id=ref.connection_id AND c.property_id=ref.property_id
       AND c.binding_generation=ref.binding_generation AND c.external_property_id=ref.provider_property_id::text
       AND c.provider='channex' AND c.connection_status='connected'
     JOIN pms.channel_room_type_mappings rm ON rm.connection_id=c.id AND rm.property_id=c.property_id
       AND rm.room_type_id=ref.room_type_id AND rm.external_room_type_id=ref.external_room_type_id::text AND rm.status='active'
     JOIN pms.room_types r ON r.id=ref.room_type_id AND r.property_id=ref.property_id AND r.active
     WHERE ref.property_id=$1::uuid AND ref.connection_id=$2::uuid AND ref.binding_generation=$3::uuid
       AND ref.guest_booking_id=$4::uuid AND ref.provider_booking_id=$5::uuid AND ref.provider_revision_id=$6::uuid
       AND ref.external_room_type_id::text=$7 AND ref.external_rate_plan_id::text=$8
       AND NOT EXISTS(SELECT 1 FROM pms.channel_rate_plan_mappings mapping
         WHERE mapping.connection_id=c.id AND mapping.property_id=c.property_id
           AND mapping.external_rate_plan_id=ref.external_rate_plan_id::text)
       AND NOT EXISTS(SELECT 1 FROM pms.room_type_closures closure WHERE closure.property_id=r.property_id AND closure.room_type_id=r.id)
     FOR SHARE OF rm,r`,
      [
        scope.propertyId,
        scope.connectionId,
        scope.bindingGeneration,
        scope.bookingId,
        scope.providerBookingId,
        scope.revisionId,
        scope.externalRoomTypeId,
        scope.externalRatePlanId,
      ],
    )
  ).rows;
}
