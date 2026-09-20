import type { Pool } from "pg";
import type { ChannexPricingJobLeaseInput } from "../jobs/pmsChannexPricingJobLease.js";
import { lockChannexPricingPropertyAuthority } from "./channexPricingPropertyAuthority.js";
import {
  channexCreationReceiptsResolved,
  readChannexCreationReceiptIdentity,
} from "./channexCreationReceiptGate.js";

type Scope = {
  propertyId: string;
  connectionId: string;
  claimId: string;
  externalPropertyId: string;
  publicationRevision: number;
  targetId: string;
  intentId: string;
  roomTypeId: string;
  offerPresent: boolean;
  primaryOccupancy?: number;
};

/** Retire only a superseded closed intent under the target lock shared by create/ARI receipts. */
export async function retireSupersededChannexOfferIntent(
  pool: Pool,
  lease: ChannexPricingJobLeaseInput,
  scope: Scope,
) {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL lock_timeout='150ms'");
    const authority = await lockChannexPricingPropertyAuthority(client, lease);
    if (
      authority.kind !== "authorized" ||
      authority.lease.propertyId !== scope.propertyId ||
      authority.lease.operationType !== "sync_ari" ||
      authority.connectionId !== scope.connectionId ||
      authority.claimId !== scope.claimId ||
      authority.externalPropertyId !== scope.externalPropertyId
    )
      return { kind: "unavailable" as const, reason: "authority_unavailable" };
    const target = (
      await client.query<{ id: string }>(
        `SELECT id FROM pms.channex_offer_targets
       WHERE id=$1 AND property_id=$2 AND connection_id=$3 AND room_type_id=$4
       FOR UPDATE NOWAIT`,
        [scope.targetId, scope.propertyId, scope.connectionId, scope.roomTypeId],
      )
    ).rows[0];
    if (!target) return { kind: "unavailable" as const, reason: "target_unavailable" };
    const intent = (
      await client.query<{
        proposal: {
          publicationRevision?: number;
          bindingGeneration?: string;
          externalPropertyId?: string;
          primaryOccupancy?: number;
        };
      }>(
        `SELECT proposal FROM pms.channex_offer_target_intents
       WHERE id=$1 AND target_id=$2 AND status='pending' FOR UPDATE NOWAIT`,
        [scope.intentId, target.id],
      )
    ).rows[0];
    if (!intent) return { kind: "unavailable" as const, reason: "intent_unavailable" };
    const head = (
      await client.query<{ revision: number }>(
        "SELECT revision FROM pms.pricing_v2_heads WHERE property_id=$1 FOR SHARE NOWAIT",
        [scope.propertyId],
      )
    ).rows[0];
    if (head?.revision !== scope.publicationRevision)
      return { kind: "unavailable" as const, reason: "publication_changed" };
    const connection = (
      await client.query<{
        generation: string;
        externalPropertyId: string;
      }>(
        `SELECT binding_generation AS generation,external_property_id AS "externalPropertyId"
       FROM pms.channel_connections WHERE id=$1 AND property_id=$2 AND provider='channex'
         AND connection_status IN ('connected','degraded','setup_incomplete')
       FOR SHARE NOWAIT`,
        [scope.connectionId, scope.propertyId],
      )
    ).rows[0];
    if (!connection || connection.externalPropertyId !== scope.externalPropertyId)
      return { kind: "unavailable" as const, reason: "connection_unavailable" };
    const mapping = (
      await client.query<{ externalRoomTypeId: string }>(
        `SELECT external_room_type_id AS "externalRoomTypeId"
       FROM pms.channel_room_type_mappings WHERE connection_id=$1 AND property_id=$2
         AND room_type_id=$3 AND status='active' FOR SHARE NOWAIT`,
        [scope.connectionId, scope.propertyId, scope.roomTypeId],
      )
    ).rows[0];
    const attempts = (
      await client.query<{
        id: string;
        state: string;
        externalPropertyId: string;
        externalRoomTypeId: string;
      }>(
        `SELECT id,state,external_property_id AS "externalPropertyId",
         external_room_type_id AS "externalRoomTypeId"
       FROM pms.channex_offer_create_attempts WHERE intent_id=$1
       ORDER BY created_at,id FOR SHARE NOWAIT`,
        [scope.intentId],
      )
    ).rows;
    const stale =
      !scope.offerPresent ||
      !mapping ||
      intent.proposal.publicationRevision !== scope.publicationRevision ||
      intent.proposal.bindingGeneration !== connection.generation ||
      intent.proposal.externalPropertyId !== scope.externalPropertyId ||
      (scope.primaryOccupancy !== undefined &&
        intent.proposal.primaryOccupancy !== scope.primaryOccupancy) ||
      attempts.some(
        (attempt) =>
          attempt.state !== "released" &&
          attempt.externalRoomTypeId !== mapping?.externalRoomTypeId,
      );
    if (!stale) {
      await client.query("COMMIT");
      committed = true;
      return { kind: "current" as const };
    }
    if (
      (
        await client.query(
          "SELECT 1 FROM pms.channex_offer_ari_attempts WHERE intent_id=$1 LIMIT 1",
          [scope.intentId],
        )
      ).rowCount
    )
      return { kind: "unavailable" as const, reason: "stale_ari_requires_reconciliation" };
    for (const attempt of attempts) {
      if (attempt.state !== "unresolved") continue;
      const receipts = (
        await client.query<{
          outcome: unknown;
          http_status: unknown;
          has_warnings: unknown;
          identity_evidence: unknown;
        }>(
          `SELECT outcome,http_status,has_warnings,identity_evidence
         FROM pms.channex_offer_create_receipts WHERE attempt_id=$1 LIMIT 2`,
          [attempt.id],
        )
      ).rows;
      const identity =
        receipts.length === 1 ? readChannexCreationReceiptIdentity(receipts[0]!) : undefined;
      if (
        !identity ||
        identity.externalPropertyId !== attempt.externalPropertyId ||
        identity.externalRoomTypeId !== attempt.externalRoomTypeId
      )
        return { kind: "unavailable" as const, reason: "stale_creation_requires_reconciliation" };
      await client.query(
        `UPDATE pms.channex_offer_create_attempts
         SET state='identified',external_rate_plan_id=$2 WHERE id=$1 AND state='unresolved'`,
        [attempt.id, identity.externalRatePlanId],
      );
    }
    if (!(await channexCreationReceiptsResolved(client, target.id)))
      return { kind: "unavailable" as const, reason: "stale_creation_requires_reconciliation" };
    await client.query(
      "UPDATE pms.channex_offer_target_intents SET status='failed' WHERE id=$1 AND status='pending'",
      [scope.intentId],
    );
    await client.query("COMMIT");
    committed = true;
    return { kind: "retired" as const };
  } catch {
    return { kind: "unavailable" as const, reason: "retirement_unavailable" };
  } finally {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}
