import type { Pool } from "pg";

import {
  prepareChannexOfferDispatch,
  readPublishedPricingForChannexJob,
  recordRetainedChannexOfferCreate,
  retainChannexOfferConfiguration,
} from "../domains/replacementPricingOfferOwners.js";
import type { ChannexManagementJob } from "../jobs/pmsChannexManagementWorker.js";
import { planChannexOfferConfiguration } from "./channexOfferConfiguration.js";

type BootstrapResult =
  | { kind: "ready" }
  | { kind: "creation_retained"; attemptId: string }
  | { kind: "unavailable"; reason: string };

/** Bridges the public saved selection to the existing one-use creation primitive. */
export async function bootstrapPublishedChannexOffer(
  pool: Pool,
  job: ChannexManagementJob,
  workerId: string,
  ports: {
    get(path: string, signal: AbortSignal): Promise<unknown>;
    create(
      request: { method: "POST"; path: "/api/v1/rate_plans"; body: unknown },
      signal: AbortSignal,
    ): Promise<Response>;
  },
): Promise<BootstrapResult> {
  const saved = job.input.publishedOffer;
  if (!saved || job.input.operationType !== "provision")
    return { kind: "unavailable", reason: "published_offer_selection_unavailable" };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    typeof saved.roomTypeId !== "string" ||
    !uuid.test(saved.roomTypeId) ||
    typeof saved.offerId !== "string" ||
    !saved.offerId.trim() ||
    saved.offerId !== saved.offerId.trim() ||
    !Number.isSafeInteger(saved.publicationRevision) ||
    saved.publicationRevision < 1 ||
    !Number.isSafeInteger(saved.primaryOccupancy) ||
    saved.primaryOccupancy < 1
  )
    return { kind: "unavailable", reason: "published_offer_selection_invalid" };
  const selection = {
    roomTypeId: saved.roomTypeId,
    offerId: saved.offerId,
    operationKey: job.jobId,
    primaryOccupancy: saved.primaryOccupancy,
  };
  const lease = { jobId: job.jobId, attemptNumber: job.attemptNumber, workerId };
  const current = await readPublishedPricingForChannexJob(pool, lease);
  if (current.kind !== "available") return current;
  if (current.publication.revision !== saved.publicationRevision)
    return { kind: "unavailable", reason: "publication_changed" };
  const room = current.publication.rooms.find(
    (room) =>
      room.roomTypeId === saved.roomTypeId &&
      room.offers.some((offer) => offer.id === saved.offerId),
  );
  if (!room) return { kind: "unavailable", reason: "published_offer_missing" };
  const plan = planChannexOfferConfiguration(room, saved.offerId, saved.primaryOccupancy);
  if (plan.kind !== "planned") return plan;
  const active = (
    await pool.query<{ matches: boolean }>(
      `SELECT (intent.status='sealed' AND version.intent_id=intent.id
         AND version.binding_generation=connection.binding_generation
         AND version.external_property_id=$5
         AND intent.proposal->>'publicationRevision'=$6
         AND intent.proposal->>'primaryOccupancy'=$7
         AND intent.proposal->'room'=$8::jsonb
         AND version.configuration=$9::jsonb
         AND NOT EXISTS (SELECT 1 FROM pms.channex_offer_target_intents pending
           WHERE pending.target_id=target.id AND pending.status='pending')) AS matches
       FROM pms.channex_offer_targets target
       JOIN pms.channel_connections connection ON connection.id=target.connection_id
       JOIN pms.channex_offer_target_versions version
         ON version.target_id=target.id AND version.version=target.active_version
       JOIN pms.channex_offer_target_intents intent ON intent.id=version.intent_id
       WHERE target.property_id=$1 AND target.connection_id=$2
         AND target.room_type_id=$3 AND target.offer_id=$4`,
      [
        job.propertyId,
        current.authority.connectionId,
        saved.roomTypeId,
        saved.offerId,
        current.authority.externalPropertyId,
        String(saved.publicationRevision),
        String(saved.primaryOccupancy),
        JSON.stringify(room),
        JSON.stringify(plan.configuration),
      ],
    )
  ).rows[0];
  if (active)
    return active.matches
      ? { kind: "ready" }
      : { kind: "unavailable", reason: "active_offer_conflict" };
  const attempt = (
    await pool.query<{ attemptId: string; state: "unresolved" | "identified"; completed: boolean }>(
      `SELECT attempt.id::text AS "attemptId",attempt.state,
         (attempt.state='identified' AND intent.status='sealed'
           AND target.active_version=intent.version AND version.intent_id=intent.id
           AND version.binding_generation=connection.binding_generation
           AND intent.proposal->>'publicationRevision'=$5
           AND NOT EXISTS (SELECT 1 FROM pms.channex_offer_target_intents pending
             WHERE pending.target_id=target.id AND pending.status='pending')) AS completed
       FROM pms.channex_offer_targets target
       JOIN pms.channel_connections connection ON connection.id=target.connection_id
       JOIN pms.channex_offer_target_intents intent ON intent.target_id=target.id
       JOIN pms.channex_offer_create_attempts attempt ON attempt.intent_id=intent.id
       LEFT JOIN pms.channex_offer_target_versions version
         ON version.target_id=target.id AND version.version=target.active_version
       WHERE target.property_id=$1 AND target.room_type_id=$2 AND target.offer_id=$3
         AND intent.operation_key=$4 AND attempt.state IN ('unresolved','identified')
       ORDER BY attempt.created_at DESC,attempt.id DESC LIMIT 2`,
      [
        job.propertyId,
        saved.roomTypeId,
        saved.offerId,
        job.jobId,
        String(saved.publicationRevision),
      ],
    )
  ).rows;
  if (attempt.length > 1) return { kind: "unavailable", reason: "creation_attempt_conflict" };
  if (attempt[0]?.completed) return { kind: "ready" };
  if (!attempt[0]) {
    const prepared = await prepareChannexOfferDispatch(pool, lease, selection);
    if (prepared.kind !== "prepared") return prepared;
    const result = await prepared.dispatch({
      getRoom: ports.get,
      create: ports.create,
    });
    if (result.kind === "receipt_pending") {
      for (const delay of [0, 100, 300]) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        try {
          await result.persist();
          return { kind: "creation_retained", attemptId: result.attemptId };
        } catch {
          // Keep the captured response in memory for bounded persistence retries.
        }
      }
      return { kind: "unavailable", reason: "creation_receipt_persistence_failed" };
    }
    if (result.kind === "retained")
      return { kind: "creation_retained", attemptId: result.attemptId };
    return result;
  }
  if (attempt[0].state === "unresolved") {
    const identified = await recordRetainedChannexOfferCreate(
      pool,
      lease,
      selection,
      attempt[0].attemptId,
    );
    if (identified.kind !== "identified") return identified;
  }
  const configured = await retainChannexOfferConfiguration(
    pool,
    lease,
    selection,
    attempt[0].attemptId,
    ports.get,
  );
  return configured.kind === "configuration_retained" ? { kind: "ready" } : configured;
}
