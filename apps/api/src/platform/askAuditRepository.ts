import crypto from "node:crypto";
import type { AskAuditRecord, AskEvidenceToolResult } from "@vayada/domain-intelligence";
import pg, { type PoolClient } from "pg";

export type AskAuditClient = Pick<PoolClient, "query" | "release">;

export type AskAuditPool = {
  connect(): Promise<AskAuditClient>;
  end(): Promise<void>;
};

type ResolvedAskScope = {
  resourceScope: "property" | "organization";
  propertyId: string | null;
};

type IdRow = {
  id: string;
};

const TOOL_PRIMARY_PERMISSION: Record<AskEvidenceToolResult["toolId"], string> = {
  get_booking_performance: "booking.analytics.read",
  get_booking_source_mix: "booking.analytics.read",
  get_conversion_funnel: "booking.analytics.read",
  get_setup_gaps: "booking.settings.read",
  get_hotel_settings_summary: "booking.settings.read",
};

export function createPgAskAuditRepository(config: {
  connectionString: string;
  max?: number;
  pool?: AskAuditPool;
}) {
  if (!config.connectionString.trim()) {
    throw new Error("Ask audit repository connectionString must not be empty");
  }

  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async recordAskRun(record: AskAuditRecord): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const scope = await resolveScope(client, record);
        const conversationId = await upsertConversation(client, record, scope);
        const runId = await insertRun(client, record, scope, conversationId);
        await insertToolCalls(client, record, scope, runId);
        await insertAnswerAudit(client, record, scope, conversationId, runId);
        await client.query("COMMIT");
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      if (ownsPool) await pool.end();
    },
  };
}

async function resolveScope(
  client: Pick<AskAuditClient, "query">,
  record: AskAuditRecord,
): Promise<ResolvedAskScope> {
  if (!record.actorInternalUserId || !record.organizationId || !record.bookingHotelId) {
    if (record.actorInternalUserId && record.organizationId && !record.bookingHotelId) {
      return { resourceScope: "organization", propertyId: null };
    }
    throw new Error("Ask audit persistence requires an authenticated actor and organization scope");
  }

  const result = await client.query<{ propertyId: string }>(
    `SELECT
        source.property_id::text AS "propertyId"
     FROM identity.organization_resource_links resource_link
     JOIN hotel_catalog.property_source_links source
       ON source.source_system = 'booking'
      AND source.source_table = 'booking_hotels'
      AND source.source_id = resource_link.resource_id
      AND source.relationship = 'canonical_input'
      AND source.status = 'active'
     WHERE resource_link.organization_id = $1::uuid
       AND resource_link.product = 'booking'
       AND resource_link.resource_type = 'booking_hotel'
       AND resource_link.resource_id = $2
       AND resource_link.status = 'active'
     ORDER BY resource_link.created_at DESC
     LIMIT 1`,
    [record.organizationId, record.bookingHotelId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Ask audit persistence could not resolve booking hotel target property");
  }
  return { resourceScope: "property", propertyId: row.propertyId };
}

async function upsertConversation(
  client: Pick<AskAuditClient, "query">,
  record: AskAuditRecord,
  scope: ResolvedAskScope,
): Promise<string> {
  const result = await client.query<IdRow>(
    `INSERT INTO intelligence.ask_conversations
       (
         conversation_key, actor_user_id, organization_id, property_id,
         resource_link_id, resource_scope, locale, retention_policy,
         last_message_at, privacy_scope, conversation_metadata
       )
     VALUES (
         $1, $2::uuid, $3::uuid, $4::uuid,
         NULL, $5, $6, 'standard',
         $7::timestamptz, 'confidential', $8::jsonb
       )
     ON CONFLICT (conversation_key) DO UPDATE
       SET last_message_at = EXCLUDED.last_message_at,
           updated_at = now()
     RETURNING id::text AS id`,
    [
      record.conversationId,
      record.actorInternalUserId,
      record.organizationId,
      scope.propertyId,
      scope.resourceScope,
      record.scope.locale ?? "en",
      record.generatedAt,
      auditJson({
        requestId: record.requestId,
        bookingHotelId: record.bookingHotelId,
      }),
    ],
  );
  return result.rows[0]!.id;
}

async function insertRun(
  client: Pick<AskAuditClient, "query">,
  record: AskAuditRecord,
  scope: ResolvedAskScope,
  conversationId: string,
): Promise<string> {
  const result = await client.query<IdRow>(
    `INSERT INTO intelligence.ask_runs
       (
         run_key, conversation_id, actor_user_id, organization_id,
         property_id, resource_scope, request_id, correlation_id,
         question_redacted_text, question_hash, detected_intent,
         required_permission_key, run_status, confidence_level,
         model_provider, model_name, prompt_version, schema_version,
         tool_plan, unavailable_data, caveats, token_usage,
         cost_metadata, started_at, finished_at, latency_ms
       )
     VALUES (
         $1, $2::uuid, $3::uuid, $4::uuid,
         $5::uuid, $6, $7, $8,
         $9, $10, $11,
         'intelligence.ask.read', $12, $13,
         $14, $15, $16, $17,
         $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb,
         $22::jsonb, $23::timestamptz, $24::timestamptz, $25
       )
     RETURNING id::text AS id`,
    [
      record.runId,
      conversationId,
      record.actorInternalUserId,
      record.organizationId,
      scope.propertyId,
      scope.resourceScope,
      record.requestId,
      record.traceId,
      redactText(record.question),
      questionHash(record.question),
      detectedIntent(record.toolPlan),
      record.status,
      record.confidence.level,
      record.modelProvider,
      record.modelName,
      record.promptVersion ?? "ask-route-preflight.v1",
      record.answerSchemaVersion ?? "ask-answer-schema.v1",
      auditJson(toolPlan(record)),
      auditJson(record.unavailableData),
      auditJson(record.caveats),
      auditJson(record.usage ?? {}),
      auditJson(costMetadata(record)),
      startedAt(record),
      record.generatedAt,
      record.latencyMs,
    ],
  );
  return result.rows[0]!.id;
}

async function insertToolCalls(
  client: Pick<AskAuditClient, "query">,
  record: AskAuditRecord,
  scope: ResolvedAskScope,
  runId: string,
): Promise<void> {
  for (const [index, result] of record.toolResults.entries()) {
    await client.query(
      `INSERT INTO intelligence.ask_tool_calls
         (
           id, run_id, tool_id, tool_version, call_sequence,
           resource_scope, organization_id, property_id,
           required_permission_key, authorization_status, result_status,
           input_scope, filters, evidence_references,
           unavailable_data, result_summary, finished_at
         )
       VALUES (
           $1::uuid, $2::uuid, $3, 'v1', $4,
           $5, $6::uuid, $7::uuid,
           $8, $9, $10,
           $11::jsonb, $12::jsonb, $13::jsonb,
           $14::jsonb, $15::jsonb, $16::timestamptz
       )`,
      [
        crypto.randomUUID(),
        runId,
        result.toolId,
        index + 1,
        scope.resourceScope,
        record.organizationId,
        scope.propertyId,
        primaryPermission(result),
        authorizationStatus(result),
        result.status,
        auditJson(result.inputScope),
        auditJson(result.filters),
        auditJson(result.evidence.map((entry) => evidenceReference(entry, result))),
        auditJson(result.unavailableData),
        auditJson({
          toolCallId: result.toolCallId,
          evidenceIds: result.evidence.map((entry) => entry.evidenceId),
          bookingHotelId: record.bookingHotelId,
        }),
        record.generatedAt,
      ],
    );
  }
}

async function insertAnswerAudit(
  client: Pick<AskAuditClient, "query">,
  record: AskAuditRecord,
  scope: ResolvedAskScope,
  conversationId: string,
  runId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO intelligence.ask_answer_audits
       (
         answer_id, run_id, conversation_id, organization_id, property_id,
         resource_scope, contract_version, answer_status, confidence_level,
         question_hash, summary, generated_answer, evidence_references,
         material_claims, suggested_actions, unavailable_data, caveats,
         retention_class, privacy_scope, audit_metadata
       )
     VALUES (
         $1, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6, $7, $8, $9,
         $10, $11, $12::jsonb, $13::jsonb,
         $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb,
         'guest_pii_excluded', 'confidential', $18::jsonb
       )`,
    [
      record.answerId,
      runId,
      conversationId,
      record.organizationId,
      scope.propertyId,
      scope.resourceScope,
      record.contractVersion,
      record.status,
      record.confidence.level,
      questionHash(record.question),
      redactText(record.summary),
      auditJson(generatedAnswer(record)),
      auditJson(answerEvidenceReferences(record)),
      auditJson(materialClaims(record)),
      auditJson(record.suggestedActions),
      auditJson(record.unavailableData),
      auditJson(record.caveats),
      auditJson(answerAuditMetadata(record)),
    ],
  );
}

function toolPlan(record: AskAuditRecord): Record<string, unknown>[] {
  const plan = record.toolPlan;
  if (plan && Array.isArray(plan.toolPlan)) return plan.toolPlan as Record<string, unknown>[];
  return record.toolResults.map((result) => ({
    toolId: result.toolId,
    toolCallId: result.toolCallId,
    status: result.status,
  }));
}

function detectedIntent(toolPlan: Record<string, unknown> | null): string | null {
  return typeof toolPlan?.intent === "string" ? toolPlan.intent : null;
}

function generatedAnswer(record: AskAuditRecord): Record<string, unknown> {
  return {
    answerId: record.answerId,
    contractVersion: record.contractVersion,
    generatedAt: record.generatedAt,
    conversationId: record.conversationId,
    runId: record.runId,
    status: record.status,
    summary: redactText(record.summary),
    blocks: record.blocks ?? [],
    evidenceReferences: answerEvidenceReferences(record),
    unavailableData: record.unavailableData,
    caveats: record.caveats,
    confidence: record.confidence,
    suggestedActions: record.suggestedActions,
    followUpQuestions: record.followUpQuestions,
    audit: {
      requestId: record.requestId,
      actorInternalUserId: record.actorInternalUserId,
      organizationId: record.organizationId,
      bookingHotelId: record.bookingHotelId,
      toolCallIds: record.toolCallIds,
      deniedToolCallIds: record.deniedToolCallIds,
    },
  };
}

function answerEvidenceReferences(record: AskAuditRecord): Record<string, unknown>[] {
  if (record.evidenceReferences.length > 0) return record.evidenceReferences;
  return record.evidenceIds.map((evidenceId) => ({ evidenceId }));
}

function materialClaims(record: AskAuditRecord): Record<string, unknown>[] {
  return record.blocks
    .map((block) => ({
      type: block.type,
      metricKey: block.metricKey,
      evidenceIds: Array.isArray(block.evidenceIds) ? block.evidenceIds : [],
    }))
    .filter((claim) => claim.evidenceIds.length > 0);
}

function costMetadata(record: AskAuditRecord): Record<string, unknown> {
  return {
    estimatedCostUsd: record.estimatedCostUsd,
    failure: record.failure,
    traceId: record.traceId,
    modelResponseIds: record.modelResponseIds,
    modelRequestIds: record.modelRequestIds,
    deniedToolCallIds: record.deniedToolCallIds,
  };
}

function answerAuditMetadata(record: AskAuditRecord): Record<string, unknown> {
  return {
    requestId: record.requestId,
    actorInternalUserId: record.actorInternalUserId,
    organizationId: record.organizationId,
    bookingHotelId: record.bookingHotelId,
    toolCallIds: record.toolCallIds,
    deniedToolCallIds: record.deniedToolCallIds,
    evidenceIds: record.evidenceIds,
    modelProvider: record.modelProvider,
    modelName: record.modelName,
    promptVersion: record.promptVersion,
    answerSchemaVersion: record.answerSchemaVersion,
    traceId: record.traceId,
    modelResponseIds: record.modelResponseIds,
    modelRequestIds: record.modelRequestIds,
    latencyMs: record.latencyMs,
    usage: record.usage,
    estimatedCostUsd: record.estimatedCostUsd,
    failure: record.failure,
  };
}

function evidenceReference(
  entry: AskEvidenceToolResult["evidence"][number],
  result: AskEvidenceToolResult,
): Record<string, unknown> {
  return {
    evidenceId: entry.evidenceId,
    toolCallId: result.toolCallId,
    toolId: result.toolId,
    sourceOwner: entry.sourceOwner,
    sourceView: entry.sourceView,
    resource: { type: entry.resourceType, id: entry.resourceId },
    metricKey: entry.metricKey,
    filters: entry.filters,
    freshness: entry.freshness,
    quality: entry.quality,
    ...(entry.sampleSize !== undefined ? { sampleSize: entry.sampleSize } : {}),
    ...(entry.aggregateId !== undefined ? { aggregateId: entry.aggregateId } : {}),
  };
}

function primaryPermission(result: AskEvidenceToolResult): string {
  return TOOL_PRIMARY_PERMISSION[result.toolId];
}

function authorizationStatus(
  result: AskEvidenceToolResult,
): "allowed" | "denied" | "not_required" | "error" {
  if (result.status === "not_authorized") return "denied";
  if (result.status === "invalid_scope") return "not_required";
  if (result.status === "error") return "error";
  return "allowed";
}

function questionHash(question: string): string {
  return `sha256:${crypto.createHash("sha256").update(question).digest("hex")}`;
}

function redactText(value: string): string {
  const redacted = redactAuditString(value);
  return redacted.trim() || "[empty question]";
}

function redactAuditString(value: string): string {
  let redacted = value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[redacted-phone]")
    .replace(
      /\b(guest_email|guest_phone|guest_name|raw_sql|provider_payment_intent_id|payout_account|private_notes|special_requests|room_number)\b/gi,
      "[redacted-field]",
    );
  if (
    /\b(select|insert|update|delete|drop|alter|create)\b[\s\S]*\b(from|into|join|table|values)\b/i.test(
      redacted,
    )
  ) {
    redacted = "[redacted database query request]";
  }
  return redacted;
}

function redactAuditJson(value: unknown): unknown {
  if (typeof value === "string") return redactAuditString(value);
  if (Array.isArray(value)) return value.map(redactAuditJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redactAuditJson(entry)]),
  );
}

function startedAt(record: AskAuditRecord): string {
  const finished = new Date(record.generatedAt);
  if (!record.latencyMs || Number.isNaN(finished.getTime())) return record.generatedAt;
  return new Date(finished.getTime() - record.latencyMs).toISOString();
}

function auditJson(value: unknown): string {
  return JSON.stringify(redactAuditJson(value));
}

async function rollbackQuietly(client: Pick<AskAuditClient, "query">): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Keep the original persistence error.
  }
}
