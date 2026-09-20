import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ChannexPricingJobLeaseInput } from "../jobs/pmsChannexPricingJobLease.js";
import { verifyChannexOfferRoom } from "../integrations/channexOfferConfiguration.js";
import { retireSupersededChannexOfferIntent } from "./channexSupersededOfferIntent.js";
import {
  prepareChannexOfferDispatch,
  readPublishedPricingForChannexJob,
  recordRetainedChannexOfferCreate,
  retainChannexOfferConfiguration,
} from "./replacementPricingOfferOwners.js";

/** Advance one published rate create per worker turn. Never infer identity from a title. */
export async function advancePublishedChannexOfferCreates(
  pool: Pool,
  lease: ChannexPricingJobLeaseInput,
  ports: {
    get(path: string, signal: AbortSignal): Promise<unknown>;
    create(
      request: { method: "POST"; path: "/api/v1/rate_plans"; body: unknown },
      signal: AbortSignal,
    ): Promise<Response>;
  },
) {
  const current = await readPublishedPricingForChannexJob(pool, lease);
  if (current.kind !== "available") return current;
  const propertyId = current.authority.lease.propertyId;
  const connectionId = current.authority.connectionId;
  const pendingIntents = await pool.query<{
    id: string;
    targetId: string;
    roomTypeId: string;
    offerId: string;
  }>(
    `SELECT i.id,t.id AS "targetId",t.room_type_id AS "roomTypeId",t.offer_id AS "offerId"
     FROM pms.channex_offer_target_intents i
     JOIN pms.channex_offer_targets t ON t.id=i.target_id
     WHERE t.property_id=$1 AND t.connection_id=$2 AND i.status='pending'
     ORDER BY i.id LIMIT 101`,
    [propertyId, connectionId],
  );
  if (pendingIntents.rows.length > 100)
    return { kind: "unavailable" as const, reason: "creation_batch_pending" };
  for (const intent of pendingIntents.rows) {
    const room = current.publication.rooms.find((item) => item.roomTypeId === intent.roomTypeId);
    const progress = await retireSupersededChannexOfferIntent(pool, lease, {
      propertyId,
      connectionId,
      claimId: current.authority.claimId,
      externalPropertyId: current.authority.externalPropertyId,
      publicationRevision: current.publication.revision,
      targetId: intent.targetId,
      intentId: intent.id,
      roomTypeId: intent.roomTypeId,
      offerPresent: Boolean(room?.offers.some((offer) => offer.id === intent.offerId)),
    });
    if (progress.kind === "unavailable") return progress;
  }
  const pending = await pool.query<{
    attemptId: string;
    roomTypeId: string;
    offerId: string;
    operationKey: string;
    primaryOccupancy: number;
  }>(
    `SELECT a.id AS "attemptId",t.room_type_id AS "roomTypeId",t.offer_id AS "offerId",
       i.operation_key AS "operationKey",(i.proposal->>'primaryOccupancy')::int AS "primaryOccupancy"
     FROM pms.channex_offer_create_attempts a
     JOIN pms.channex_offer_targets t ON t.id=a.target_id
     JOIN pms.channex_offer_target_intents i ON i.id=a.intent_id
     WHERE t.property_id=$1 AND t.connection_id=$2 AND i.status='pending'
       AND NOT (i.result_evidence ? 'configuration')
       AND a.state IN ('unresolved','identified')
     ORDER BY a.created_at,a.id LIMIT 1`,
    [propertyId, connectionId],
  );
  const retained = pending.rows[0];
  if (retained) {
    const selection = {
      roomTypeId: retained.roomTypeId,
      offerId: retained.offerId,
      operationKey: retained.operationKey,
      primaryOccupancy: retained.primaryOccupancy,
    };
    const identified = await recordRetainedChannexOfferCreate(
      pool,
      lease,
      selection,
      retained.attemptId,
    );
    if (identified.kind !== "identified") return identified;
    const configured = await retainChannexOfferConfiguration(
      pool,
      lease,
      selection,
      retained.attemptId,
      ports.get,
    );
    if (configured.kind !== "configuration_retained") return configured;
  }
  const targets = await pool.query<{
    targetId: string;
    roomTypeId: string;
    offerId: string;
    activeVersion: string | null;
    activeRevision: number | null;
    activeBindingGeneration: string | null;
    activeExternalPropertyId: string | null;
    activeExternalRoomTypeId: string | null;
    pending: boolean;
    hasAttempt: boolean;
    hasUnconfiguredAttempt: boolean;
    pendingOperationKey: string | null;
    pendingIntentId: string | null;
    pendingPrimaryOccupancy: number | null;
  }>(
    `SELECT t.id AS "targetId",t.room_type_id AS "roomTypeId",t.offer_id AS "offerId",
       t.active_version AS "activeVersion",
       (i.proposal->>'publicationRevision')::int AS "activeRevision",
       v.binding_generation AS "activeBindingGeneration",
       v.external_property_id AS "activeExternalPropertyId",
       v.external_room_type_id AS "activeExternalRoomTypeId",
       EXISTS (SELECT 1 FROM pms.channex_offer_target_intents i
         WHERE i.target_id=t.id AND i.status='pending') AS pending,
       EXISTS (SELECT 1 FROM pms.channex_offer_create_attempts a
         JOIN pms.channex_offer_target_intents i ON i.id=a.intent_id
         WHERE i.target_id=t.id AND i.status='pending' AND a.state<>'released') AS "hasAttempt",
       EXISTS (SELECT 1 FROM pms.channex_offer_create_attempts a
         JOIN pms.channex_offer_target_intents i ON i.id=a.intent_id
         WHERE i.target_id=t.id AND i.status='pending' AND a.state<>'released'
           AND NOT (i.result_evidence ? 'configuration')) AS "hasUnconfiguredAttempt",
       (SELECT i.operation_key FROM pms.channex_offer_target_intents i
         WHERE i.target_id=t.id AND i.status='pending') AS "pendingOperationKey",
       (SELECT i.id FROM pms.channex_offer_target_intents i
         WHERE i.target_id=t.id AND i.status='pending') AS "pendingIntentId",
       (SELECT (i.proposal->>'primaryOccupancy')::int FROM pms.channex_offer_target_intents i
         WHERE i.target_id=t.id AND i.status='pending') AS "pendingPrimaryOccupancy"
     FROM pms.channex_offer_targets t
     LEFT JOIN pms.channex_offer_target_versions v
       ON v.target_id=t.id AND v.version=t.active_version
     LEFT JOIN pms.channex_offer_target_intents i ON i.id=v.intent_id
     WHERE t.property_id=$1 AND t.connection_id=$2`,
    [propertyId, connectionId],
  );
  const binding = await pool.query<{ generation: string }>(
    `SELECT binding_generation AS generation FROM pms.channel_connections WHERE id=$1`,
    [connectionId],
  );
  if (binding.rows.length !== 1)
    return { kind: "unavailable" as const, reason: "connection_unavailable" };
  const generation = binding.rows[0]!.generation;
  const mappings = await pool.query<{ roomTypeId: string; externalRoomTypeId: string }>(
    `SELECT room_type_id AS "roomTypeId", external_room_type_id AS "externalRoomTypeId"
     FROM pms.channel_room_type_mappings
     WHERE property_id=$1 AND connection_id=$2 AND status='active'`,
    [propertyId, connectionId],
  );
  let pendingReconciliation = false;
  for (const room of current.publication.rooms) {
    const mapping = mappings.rows.find((row) => row.roomTypeId === room.roomTypeId);
    if (!mapping) continue;
    for (const offer of room.offers) {
      const target = targets.rows.find(
        (row) => row.roomTypeId === room.roomTypeId && row.offerId === offer.id,
      );
      if (
        target?.activeVersion &&
        !target.pending &&
        target.activeRevision === current.publication.revision &&
        target.activeBindingGeneration === generation &&
        target.activeExternalPropertyId === current.authority.externalPropertyId &&
        target.activeExternalRoomTypeId === mapping.externalRoomTypeId
      )
        continue;
      if (target?.pending && target.hasAttempt) {
        pendingReconciliation ||= target.hasUnconfiguredAttempt;
        continue;
      }
      const externalRoomTypeId = mapping.externalRoomTypeId;
      const roomPath = `/api/v1/room_types/${encodeURIComponent(externalRoomTypeId)}`;
      const response = await ports.get(roomPath, AbortSignal.timeout(15_000));
      await verifyChannexOfferRoom(
        room,
        { externalPropertyId: current.authority.externalPropertyId, externalRoomTypeId },
        async () => response,
      );
      const data =
        response && typeof response === "object" && "data" in response ? response.data : null;
      const attributes =
        data && typeof data === "object" && "attributes" in data ? data.attributes : null;
      const primaryOccupancy =
        attributes && typeof attributes === "object" && "default_occupancy" in attributes
          ? attributes.default_occupancy
          : null;
      if (
        !Number.isSafeInteger(primaryOccupancy) ||
        (primaryOccupancy as number) < 1 ||
        (primaryOccupancy as number) > room.capacity.adults
      )
        return { kind: "unavailable" as const, reason: "primary_occupancy_unavailable" };
      let retired = false;
      if (target?.pendingIntentId && target.pendingPrimaryOccupancy !== primaryOccupancy) {
        const progress = await retireSupersededChannexOfferIntent(pool, lease, {
          propertyId,
          connectionId,
          claimId: current.authority.claimId,
          externalPropertyId: current.authority.externalPropertyId,
          publicationRevision: current.publication.revision,
          targetId: target.targetId,
          intentId: target.pendingIntentId,
          roomTypeId: room.roomTypeId,
          offerPresent: true,
          primaryOccupancy: primaryOccupancy as number,
        });
        if (progress.kind === "unavailable") return progress;
        retired = progress.kind === "retired";
      }
      const selection = {
        roomTypeId: room.roomTypeId,
        offerId: offer.id,
        operationKey:
          (!retired ? target?.pendingOperationKey : null) ??
          `published:${current.publication.revision}:${randomUUID()}`,
        primaryOccupancy: primaryOccupancy as number,
      };
      const prepared = await prepareChannexOfferDispatch(pool, lease, selection);
      if (prepared.kind !== "prepared") return prepared;
      return prepared.dispatch({ getRoom: ports.get, create: ports.create });
    }
  }
  return pendingReconciliation
    ? { kind: "unavailable" as const, reason: "creation_batch_pending" }
    : { kind: "offer_creates_current" as const };
}
