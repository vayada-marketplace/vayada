import type { PoolClient } from "pg";

/** What a Channex stay booked on an offer-owned rate plan keeps about that offer (VAY-2108). */
export type ChannexOfferLink = {
  targetId: string;
  version: string;
  offerId: string;
  roomTypeId: string;
  externalRatePlanId: string;
};

/**
 * VAY-2108: from the switch-day remap on, OTAs sell the Channex rate plans our published offers
 * create. 0314 records each one as owned by its offer target and forbids a legacy mapping row for
 * it, so intake resolves it here instead, to the target's room type, which the stay's Channex
 * room must also map to (active mapping, active room type, not closed).
 *
 * A new stay needs the plan of the target's active version on the connection's current binding.
 * A plan of a superseded version, a target without an active version or a version from an older
 * binding resolves to nothing, and the caller refuses with operational_mapping_unavailable.
 * A revision of a booking that already has a stay on this target (`priorTargetIds`, any room, so
 * reordered rooms still match) also accepts the target's earlier versions and bindings, so OTA
 * changes to an accepted booking keep arriving after the offer moves on. The owner still fixes
 * the target, so a prior id of another target never widens anything. The 0314 registry gives a plan one owner per connection and the
 * target's room type never changes, so a plan never resolves to two room types.
 *
 * The rate plan stays null: pms.rate_plans holds legacy plans only (as for manual offer bookings
 * and the staging catalog path). The target row is not locked. Its room type is immutable (0314
 * guard), and offer creation takes it FOR UPDATE NOWAIT, which a share lock here would fail.
 */
export async function resolveChannexOfferRatePlan(
  client: PoolClient,
  scope: {
    propertyId: string;
    connectionId: string;
    externalRoomTypeId: string;
    externalRatePlanId: string;
    priorTargetIds: readonly string[];
  },
) {
  return (
    await client.query<{ roomTypeId: string; ratePlanId: null; channexOffer: ChannexOfferLink }>(
      `SELECT r.id::text AS "roomTypeId",NULL::text AS "ratePlanId",
       jsonb_build_object('targetId',t.id::text,'version',v.version::text,'offerId',t.offer_id,
         'roomTypeId',r.id::text,'externalRatePlanId',$4::text) AS "channexOffer"
     FROM pms.channex_external_rate_owners owner
     JOIN pms.channex_offer_targets t ON t.id=owner.owner_id AND t.connection_id=owner.connection_id
     JOIN pms.channel_connections c ON c.id=t.connection_id AND c.property_id=t.property_id
       AND c.provider='channex'
     JOIN LATERAL (
       SELECT version.version,version.external_room_type_id FROM pms.channex_offer_target_versions version
       WHERE version.target_id=t.id AND version.external_rate_plan_id=$4 AND version.external_room_type_id=$3
         AND ((version.version=t.active_version AND version.binding_generation=c.binding_generation
             AND version.external_property_id=c.external_property_id)
           OR t.id=ANY($5::uuid[]))
       ORDER BY version.version DESC LIMIT 1
     ) v ON TRUE
     JOIN pms.channel_room_type_mappings rm ON rm.connection_id=t.connection_id
       AND rm.property_id=t.property_id AND rm.room_type_id=t.room_type_id
       AND rm.external_room_type_id=v.external_room_type_id AND rm.status='active'
     JOIN pms.room_types r ON r.id=t.room_type_id AND r.property_id=t.property_id AND r.active
     WHERE owner.connection_id=$2::uuid AND owner.external_rate_plan_id=$4 AND owner.owner_kind='offer'
       AND t.property_id=$1::uuid
       AND NOT EXISTS(SELECT 1 FROM pms.room_type_closures closure
         WHERE closure.property_id=r.property_id AND closure.room_type_id=r.id)
     FOR SHARE OF rm,r`,
      [
        scope.propertyId,
        scope.connectionId,
        scope.externalRoomTypeId,
        scope.externalRatePlanId,
        [...scope.priorTargetIds],
      ],
    )
  ).rows;
}
