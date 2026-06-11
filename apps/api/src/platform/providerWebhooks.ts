import { createHash } from "node:crypto";
import pg from "pg";

import type {
  ProviderWebhookPromotionInput,
  ProviderWebhookPromotionResult,
  ProviderWebhookReceiptInput,
  ProviderWebhookReceiptResult,
  ProviderWebhookStore,
} from "../routes/providerWebhooks.js";

type PgProviderWebhookStoreConfig = {
  connectionString: string;
  max?: number;
};

export function createPgProviderWebhookStore(
  config: PgProviderWebhookStoreConfig,
): ProviderWebhookStore {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async recordReceipt(input) {
      return recordReceipt(pool, input);
    },
    async promoteReceipt(input) {
      return promoteReceipt(pool, input);
    },
    async close() {
      await pool.end();
    },
  };
}

async function recordReceipt(
  pool: pg.Pool,
  input: ProviderWebhookReceiptInput,
): Promise<ProviderWebhookReceiptResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ id: string; delivery_status: string }>(
      `INSERT INTO platform.external_webhook_events
         (
           provider,
           provider_event_id,
           webhook_key_hash,
           event_type,
           delivery_status,
           signature_verified,
           payload_hash,
           raw_headers,
           raw_payload
         )
       VALUES ($1, $2, $3, $4, 'observed', TRUE, $5, $6, $7)
       ON CONFLICT (provider, provider_event_id) DO NOTHING
       RETURNING id, delivery_status`,
      [
        input.provider,
        input.providerEventId,
        input.receiptKeyHash,
        input.eventType,
        input.payloadHash,
        JSON.stringify(input.rawHeaders),
        JSON.stringify(input.rawPayload),
      ],
    );

    const row = inserted.rows[0];
    if (row) {
      await insertOrTouchIdempotencyKey(client, {
        operation: "external_webhook_receipt",
        keyHash: input.receiptKeyHash,
        requestFingerprintHash: input.payloadHash,
        responseResourceProduct: "platform",
        responseResourceType: "external_webhook_event",
        responseResourceId: row.id,
        metadata: {
          provider: input.provider,
          receiptKey: input.receiptKey,
          mode: input.mode,
          eventType: input.eventType,
          normalizedDomainEventKey: input.normalizedPreview.domainEventKey,
        },
      });
      await client.query("COMMIT");
      return { status: "inserted", receiptId: row.id, lifecycleStatus: "observed" };
    }

    const existing = await selectExistingReceipt(client, input.provider, input.providerEventId);
    if (!existing) {
      throw new Error(`Unable to resolve provider webhook receipt ${input.providerEventId}`);
    }
    if (existing.payload_hash !== input.payloadHash) {
      await client.query("COMMIT");
      return {
        status: "conflict",
        receiptId: existing.id,
        lifecycleStatus:
          existing.delivery_status as ProviderWebhookReceiptResult["lifecycleStatus"],
      };
    }
    await insertOrTouchIdempotencyKey(client, {
      operation: "external_webhook_receipt",
      keyHash: input.receiptKeyHash,
      requestFingerprintHash: input.payloadHash,
      responseResourceProduct: "platform",
      responseResourceType: "external_webhook_event",
      responseResourceId: existing.id,
      metadata: {
        provider: input.provider,
        receiptKey: input.receiptKey,
        mode: input.mode,
        eventType: input.eventType,
        duplicate: true,
      },
    });
    await client.query("COMMIT");
    return {
      status: "duplicate",
      receiptId: existing.id,
      lifecycleStatus: existing.delivery_status as ProviderWebhookReceiptResult["lifecycleStatus"],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function promoteReceipt(
  pool: pg.Pool,
  input: ProviderWebhookPromotionInput,
): Promise<ProviderWebhookPromotionResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insertOrTouchIdempotencyKey(client, {
      operation: "external_webhook_domain_event",
      keyHash: hashForKey(input.normalizedPreview.domainEventKey),
      requestFingerprintHash: input.payloadHash,
      responseResourceProduct: input.normalizedPreview.resourceProduct,
      responseResourceType: input.normalizedPreview.resourceType,
      responseResourceId: input.normalizedPreview.resourceId,
      metadata: {
        provider: input.provider,
        receiptKey: input.receiptKey,
        domainEventKey: input.normalizedPreview.domainEventKey,
      },
    });

    const eventId = await insertOrFindDomainEvent(client, input);
    const jobId = await insertOrFindJob(client, input, eventId);

    await insertOrTouchIdempotencyKey(client, {
      operation: "external_webhook_job",
      keyHash: hashForKey(input.normalizedPreview.jobKey),
      requestFingerprintHash: input.payloadHash,
      responseResourceProduct: input.normalizedPreview.resourceProduct,
      responseResourceType: input.normalizedPreview.resourceType,
      responseResourceId: input.normalizedPreview.resourceId,
      metadata: {
        provider: input.provider,
        receiptKey: input.receiptKey,
        jobKey: input.normalizedPreview.jobKey,
        jobId,
      },
    });

    const updated = await client.query<{ id: string }>(
      `UPDATE platform.external_webhook_events
       SET delivery_status = 'promoted',
           normalized_domain_event_id = $2,
           processed_at = now(),
           correlation_id = $3
       WHERE id = $1
         AND delivery_status IN ('received', 'validated', 'observed')
       RETURNING id`,
      [input.receiptId, eventId, input.receiptKey],
    );

    const promotionStatus = updated.rows[0]
      ? "promoted"
      : promotionStatusForReceipt(await requireReceiptStatusById(client, input.receiptId));

    await client.query("COMMIT");
    return {
      status: promotionStatus,
      receiptId: input.receiptId,
      domainEventId: eventId,
      jobIds: [jobId],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function selectExistingReceipt(
  client: pg.PoolClient,
  provider: string,
  providerEventId: string,
): Promise<{ id: string; delivery_status: string; payload_hash: string } | null> {
  const existing = await client.query<{
    id: string;
    delivery_status: string;
    payload_hash: string;
  }>(
    `SELECT id, delivery_status, payload_hash
     FROM platform.external_webhook_events
     WHERE provider = $1 AND provider_event_id = $2
     LIMIT 1`,
    [provider, providerEventId],
  );
  return existing.rows[0] ?? null;
}

async function requireReceiptStatusById(client: pg.PoolClient, receiptId: string): Promise<string> {
  const existing = await client.query<{ delivery_status: string }>(
    `SELECT delivery_status
     FROM platform.external_webhook_events
     WHERE id = $1
     LIMIT 1`,
    [receiptId],
  );
  const status = existing.rows[0]?.delivery_status;
  if (!status) {
    throw new Error(`Provider webhook receipt ${receiptId} not found during promotion`);
  }
  return status;
}

function promotionStatusForReceipt(status: string): ProviderWebhookPromotionResult["status"] {
  switch (status) {
    case "promoted":
    case "succeeded":
      return "already_promoted";
    case "normalized":
      return "already_normalized";
    case "failed":
      return "failed";
    case "dead_lettered":
      return "dead_lettered";
    case "ignored":
      return "incompatible_terminal_state";
    default:
      return "incompatible_terminal_state";
  }
}

async function insertOrFindDomainEvent(
  client: pg.PoolClient,
  input: ProviderWebhookPromotionInput,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO platform.domain_events
       (
         source_system,
         event_key,
         event_type,
         occurred_at,
         tenant_scope,
         resource_product,
         resource_type,
         resource_id,
         actor_type,
         correlation_id,
         causation_id,
         idempotency_key_hash,
         payload,
         event_metadata,
         privacy_scope
       )
     VALUES (
       'external',
       $1,
       $2,
       now(),
       'external',
       $3,
       $4,
       $5,
       'provider',
       $6,
       $7,
       $8,
       $9,
       $10,
       'restricted'
     )
     ON CONFLICT (source_system, event_key) DO NOTHING
     RETURNING id`,
    [
      input.normalizedPreview.domainEventKey,
      input.normalizedPreview.domainEventType,
      input.normalizedPreview.resourceProduct,
      input.normalizedPreview.resourceType,
      input.normalizedPreview.resourceId,
      input.receiptKey,
      input.receiptId,
      hashForKey(input.normalizedPreview.domainEventKey),
      JSON.stringify(input.normalizedPreview.payload),
      JSON.stringify({
        provider: input.provider,
        receiptId: input.receiptId,
        receiptKey: input.receiptKey,
      }),
    ],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId) return insertedId;

  const existing = await client.query<{ id: string }>(
    `SELECT id
     FROM platform.domain_events
     WHERE source_system = 'external' AND event_key = $1
     LIMIT 1`,
    [input.normalizedPreview.domainEventKey],
  );
  const existingId = existing.rows[0]?.id;
  if (!existingId) {
    throw new Error(`Unable to resolve domain event ${input.normalizedPreview.domainEventKey}`);
  }
  return existingId;
}

async function insertOrFindJob(
  client: pg.PoolClient,
  input: ProviderWebhookPromotionInput,
  domainEventId: string,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO platform.jobs
       (
         job_key,
         queue_name,
         job_type,
         source_domain_event_id,
         tenant_scope,
         resource_product,
         resource_type,
         resource_id,
         correlation_id,
         idempotency_key_hash,
         payload,
         job_metadata
       )
     VALUES ($1, $2, $3, $4, 'external', $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (queue_name, job_key) DO NOTHING
     RETURNING id`,
    [
      input.normalizedPreview.jobKey,
      input.normalizedPreview.queueName,
      input.normalizedPreview.jobType,
      domainEventId,
      input.normalizedPreview.resourceProduct,
      input.normalizedPreview.resourceType,
      input.normalizedPreview.resourceId,
      input.receiptKey,
      hashForKey(input.normalizedPreview.jobKey),
      JSON.stringify({
        ...input.normalizedPreview.payload,
        receiptId: input.receiptId,
        receiptKey: input.receiptKey,
      }),
      JSON.stringify({
        provider: input.provider,
        source: "target_provider_webhook_intake",
      }),
    ],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId) return insertedId;

  const existing = await client.query<{ id: string }>(
    `SELECT id
     FROM platform.jobs
     WHERE queue_name = $1 AND job_key = $2
     LIMIT 1`,
    [input.normalizedPreview.queueName, input.normalizedPreview.jobKey],
  );
  const existingId = existing.rows[0]?.id;
  if (!existingId) {
    throw new Error(`Unable to resolve webhook job ${input.normalizedPreview.jobKey}`);
  }
  return existingId;
}

async function insertOrTouchIdempotencyKey(
  client: pg.PoolClient,
  input: {
    operation: string;
    keyHash: string;
    requestFingerprintHash: string;
    responseResourceProduct: string;
    responseResourceType: string;
    responseResourceId: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.idempotency_keys
       (
         operation_scope,
         operation,
         key_hash,
         request_fingerprint_hash,
         status,
         tenant_scope,
         response_status_code,
         response_resource_product,
         response_resource_type,
         response_resource_id,
         response_body_hash,
         completed_at,
         expires_at,
         idempotency_metadata
       )
     VALUES (
       'platform',
       $1,
       $2,
       $3,
       'completed',
       'external',
       200,
       $4,
       $5,
       $6,
       $7,
       now(),
       now() + interval '180 days',
       $8
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET
       last_seen_at = now(),
       idempotency_metadata = platform.idempotency_keys.idempotency_metadata || EXCLUDED.idempotency_metadata`,
    [
      input.operation,
      input.keyHash,
      input.requestFingerprintHash,
      input.responseResourceProduct,
      input.responseResourceType,
      input.responseResourceId,
      input.requestFingerprintHash,
      JSON.stringify(input.metadata),
    ],
  );
}

function hashForKey(key: string): string {
  return key.startsWith("sha256:")
    ? key
    : `sha256:${createHash("sha256").update(key).digest("hex")}`;
}
