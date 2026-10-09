import { createHash } from "node:crypto";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { deterministicUuid } from "./productionBookingValues.js";
import type { PmsBuildContext, PmsTargetRecord } from "./productionPmsTypes.js";
import { pmsRecord } from "./productionPmsValues.js";

/** VAY-1362: one native PMS command the import replays for a cohort property. */
export type NativeCommand = {
  source: IdentitySourceRow;
  propertyId: string;
  /** Names the command in its deterministic IDs and idempotency key. */
  name: string;
  at: string;
  /** Idempotency operation and audit action. */
  operation: string;
  /** The native request fingerprint text, hashed as the native writer hashes it. */
  fingerprint: string;
  /** The native command result; its hash is the response hash. */
  result: unknown;
  /** How the native writer stores the result for replay in idempotency_metadata. */
  replay: Record<string, unknown>;
  eventType: string;
  resourceType: string;
  payload: unknown;
  metadata: Record<string, unknown>;
  destination: string;
  eventKey(keyHash: string): string;
  outboxKey(keyHash: string): string;
  auditKey(keyHash: string): string;
  redactedPayload: unknown;
  auditMetadata: Record<string, unknown>;
  checksumInput: unknown;
};

/**
 * The idempotency key, domain event, outbox row and audit row a native PMS command writes around
 * its change (completed, attempt 1), keyed so reruns plan the same rows. The migration is the
 * actor; the key is the run's, so it never collides with a native request.
 */
export function nativeCommandRecords(
  context: Pick<PmsBuildContext, "sourceRunId">,
  command: NativeCommand,
): { ids: { idempotency: string; event: string; outbox: string }; records: PmsTargetRecord[] } {
  const { propertyId, at } = command;
  const id = (kind: string) =>
    deterministicUuid("production-pms", "native-command", command.name, kind, propertyId);
  const ids = { idempotency: id("idempotency"), event: id("event"), outbox: id("outbox") };
  const keyHash = sha256Hex(
    `vay1362-migration:${context.sourceRunId}:${command.name}:${propertyId}`,
  );
  const correlationId = `vay1362-migration:${context.sourceRunId}`;
  const scope = { tenantScope: "property", organizationId: null, propertyId };
  const resource = { resourceProduct: "pms", resourceType: command.resourceType };
  const record = (table: string, row: Record<string, unknown>) =>
    pmsRecord(
      command.source,
      table,
      String(row["id"]),
      at,
      false,
      row,
      command.checksumInput,
      "platform",
    );
  return {
    ids,
    records: [
      record("idempotency_keys", {
        id: ids.idempotency,
        operationScope: "pms",
        operation: command.operation,
        keyHash,
        requestFingerprintHash: sha256Hex(command.fingerprint),
        status: "completed",
        ...scope,
        responseStatusCode: 200,
        responseBodyHash: sha256Hex(nativeStableJson(command.result)),
        correlationId,
        firstSeenAt: at,
        lastSeenAt: at,
        completedAt: at,
        expiresAt: new Date(Date.parse(at) + 86_400_000).toISOString(),
        idempotencyMetadata: { attempt: 1, ...command.replay },
      }),
      record("domain_events", {
        id: ids.event,
        sourceSystem: "pms",
        eventKey: command.eventKey(keyHash),
        eventType: command.eventType,
        eventVersion: 1,
        occurredAt: at,
        ...scope,
        ...resource,
        resourceId: propertyId,
        actorType: "migration",
        actorUserId: null,
        correlationId,
        causationId: context.sourceRunId,
        idempotencyKeyHash: keyHash,
        payload: command.payload,
        eventMetadata: command.metadata,
        privacyScope: "confidential",
      }),
      record("outbox_events", {
        id: ids.outbox,
        domainEventId: ids.event,
        outboxKey: command.outboxKey(keyHash),
        destination: command.destination,
        eventType: command.eventType,
        ...scope,
        ...resource,
        resourceId: propertyId,
        correlationId,
        idempotencyKeyHash: keyHash,
        payload: command.payload,
        outboxMetadata: command.metadata,
        createdAt: at,
      }),
      record("product_audit_events", {
        id: id("audit"),
        auditKey: command.auditKey(keyHash),
        product: "pms",
        action: command.operation,
        actionVersion: 1,
        occurredAt: at,
        recordedAt: at,
        ...scope,
        actorType: "migration",
        actorUserId: null,
        targetResourceProduct: "pms",
        targetResourceType: command.resourceType,
        targetResourceId: propertyId,
        domainEventId: ids.event,
        idempotencyKeyId: ids.idempotency,
        correlationId,
        causationId: context.sourceRunId,
        redactedPayload: command.redactedPayload,
        privatePayload: {},
        auditMetadata: { migrationRunId: context.sourceRunId, ...command.auditMetadata },
        retentionClass: "standard",
        privacyScope: "confidential",
        aiVisible: false,
      }),
    ],
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The native writers' stable JSON (keys in code-unit order), so response hashes match theirs. */
function nativeStableJson(value: unknown): string {
  const sort = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(sort)
      : entry && typeof entry === "object"
        ? Object.fromEntries(
            Object.keys(entry)
              .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
              .map((key) => [key, sort((entry as Record<string, unknown>)[key])]),
          )
        : entry;
  return JSON.stringify(sort(value));
}
