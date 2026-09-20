import { createHash } from "node:crypto";

import {
  MARKETPLACE_COMMUNICATIONS_CONTRACT_VERSION,
  MARKETPLACE_COMMUNICATIONS_INITIAL_POLICY,
  parseMarketplaceCommunicationPreferences,
  parseReplaceMarketplaceCommunicationPreferencesResult,
  resolveMarketplaceCommunicationPreferenceDefaults,
  serializeReplaceMarketplaceCommunicationPreferencesFingerprint,
  type MarketplaceCommunicationPreferenceCommandPort,
  type MarketplaceCommunicationPreferencePolicy,
  type MarketplaceCommunicationPreferenceReadPort,
  type MarketplaceCommunicationPreferenceScope,
  type MarketplaceCommunicationPreferencesV1,
  type MarketplaceCommunicationUnsubscribeCommand,
  type MarketplaceCommunicationUnsubscribeCommandPort,
  type ReplaceMarketplaceCommunicationPreferencesCommand,
  type ReplaceMarketplaceCommunicationPreferencesResult,
} from "@vayada/domain-marketplace";
import pg, { type QueryResult, type QueryResultRow } from "pg";

const OPERATION = "marketplace.communication_preferences.replace";
const UNSUBSCRIBE_OPERATION = "marketplace.communication_preferences.unsubscribe_topic";
const RESOURCE_TYPE = "communication_preferences";

export type MarketplaceCommunicationPreferencesClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};
export type MarketplaceCommunicationPreferencesPool = {
  connect(): Promise<MarketplaceCommunicationPreferencesClient>;
  end(): Promise<void>;
};
export type MarketplaceCommunicationPreferencesRepositoryConfig = {
  connectionString: string;
  max?: number;
  pool?: MarketplaceCommunicationPreferencesPool;
  now?: () => Date;
  lockTimeoutMs?: number;
  policy?: MarketplaceCommunicationPreferencePolicy;
};
export type MarketplaceCommunicationPreferencesRepository =
  MarketplaceCommunicationPreferenceReadPort &
    MarketplaceCommunicationPreferenceCommandPort &
    MarketplaceCommunicationUnsubscribeCommandPort & { close(): Promise<void> };

type PreferenceRow = {
  organizationId: string;
  revision: number | string;
  emailState: unknown;
  emailSource: unknown;
  emailEffectiveAt: Date | string | null;
  topicCadence: unknown;
  topicSource: unknown;
  topicEffectiveAt: Date | string | null;
};
type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  responseResourceProduct: string | null;
  responseResourceType: string | null;
  responseResourceId: string | null;
  idempotencyMetadata: unknown;
  expiresAt: Date | string;
};

export function createPgMarketplaceCommunicationPreferencesRepository(
  config: MarketplaceCommunicationPreferencesRepositoryConfig,
): MarketplaceCommunicationPreferencesRepository {
  if (!config.connectionString.trim()) throw new Error("connectionString must not be empty");
  const ownsPool = !config.pool;
  const pool: MarketplaceCommunicationPreferencesPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });
  const now = config.now ?? (() => new Date());
  const policy = config.policy ?? MARKETPLACE_COMMUNICATIONS_INITIAL_POLICY;
  const lockTimeoutMs = config.lockTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
    throw new Error("lockTimeoutMs must be a positive integer");
  }

  return {
    async getCommunicationPreferences(scope) {
      const defaults = resolveMarketplaceCommunicationPreferenceDefaults(scope);
      const client = await pool.connect();
      try {
        return (await readStoredPreferences(client, scope)) ?? defaults;
      } finally {
        client.release();
      }
    },

    async replaceCommunicationPreferences(command) {
      if (command.audit.actorUserId !== command.userId) return failed("scope_forbidden");
      const acceptedAt = now();
      validateCommandEnvelope(command, acceptedAt);
      const keyHash = sha256(`${command.userId}:${command.idempotencyKey}`);
      const fingerprint = sha256(
        serializeReplaceMarketplaceCommunicationPreferencesFingerprint(command),
      );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('lock_timeout', $1, true)", [`${lockTimeoutMs}ms`]);
        await client.query("SET LOCAL statement_timeout = '15s'");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `${command.organizationId}:${command.userId}`,
        ]);

        const replay = await findReplay(client, command, keyHash, fingerprint, acceptedAt);
        if (replay) {
          await client.query("ROLLBACK");
          return replay;
        }
        const idempotencyId = await reserveIdempotency(
          client,
          command,
          keyHash,
          fingerprint,
          acceptedAt,
        );
        if (!idempotencyId) {
          await client.query("ROLLBACK");
          return failed("command_in_progress");
        }

        const current = await lockAggregate(client, command);
        const currentRevision = current?.revision ?? 0;
        if (currentRevision !== command.request.expectedRevision) {
          const result = failed("preference_conflict", currentRevision);
          await recordAudit(client, command, idempotencyId, result, false, acceptedAt);
          await completeIdempotency(client, idempotencyId, command.userId, result, acceptedAt);
          await client.query("COMMIT");
          return result;
        }

        const before = current ? await readStoredPreferences(client, { ...command, policy }) : null;
        if (current && !before) throw new Error("Communication preference aggregate is incomplete");
        const changed = await persistPreferences(
          client,
          command,
          current?.id ?? null,
          before,
          acceptedAt,
        );
        const preferences = changed
          ? await readStoredPreferences(client, { ...command, policy })
          : before;
        if (!preferences) throw new Error("Communication preference write was not readable");
        const result: ReplaceMarketplaceCommunicationPreferencesResult = {
          ok: true,
          preferences,
        };
        await recordAudit(client, command, idempotencyId, result, changed, acceptedAt);
        await completeIdempotency(client, idempotencyId, command.userId, result, acceptedAt);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await rollbackQuietly(client);
        if (lockUnavailable(error)) return failed("command_in_progress");
        throw error;
      } finally {
        client.release();
      }
    },

    async unsubscribeCommunicationTopic(command) {
      const acceptedAt = new Date(command.audit.requestedAt);
      validateUnsubscribeCommand(command, acceptedAt);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('lock_timeout', $1, true)", [`${lockTimeoutMs}ms`]);
        await client.query("SET LOCAL statement_timeout = '15s'");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `${command.claims.organizationId}:${command.claims.userId}`,
        ]);

        if (await findUnsubscribeReplay(client, command)) {
          await client.query("ROLLBACK");
          return { ok: true, replayed: true };
        }
        const idempotencyId = await reserveUnsubscribe(client, command, acceptedAt);
        if (!idempotencyId) throw new Error("Unsubscribe token reservation failed");

        const current = await lockAggregate(client, {
          organizationId: command.claims.organizationId,
          userId: command.claims.userId,
        });
        const topic = current ? await readStoredTopic(client, command) : null;
        const changed = topic?.cadence !== "off" || topic.source !== "signed_unsubscribe";
        const revision = changed
          ? await persistTopicUnsubscribe(client, command, current, acceptedAt)
          : current!.revision;
        await recordUnsubscribeAudit(client, command, idempotencyId, revision, changed, acceptedAt);
        await completeUnsubscribe(client, idempotencyId, acceptedAt);
        await client.query("COMMIT");
        return { ok: true, replayed: false };
      } catch (error) {
        await rollbackQuietly(client);
        if (foreignKeyViolation(error)) {
          return { ok: false, error: { code: "invalid_scope" } };
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function readStoredPreferences(
  client: MarketplaceCommunicationPreferencesClient,
  scope: MarketplaceCommunicationPreferenceScope,
): Promise<MarketplaceCommunicationPreferencesV1 | null> {
  const defaults = resolveMarketplaceCommunicationPreferenceDefaults(scope);
  const result = await client.query<PreferenceRow>(
    `SELECT sets.organization_id::text AS "organizationId",
            sets.revision, channel.state AS "emailState", channel.source AS "emailSource",
            channel.effective_at AS "emailEffectiveAt", topic.cadence AS "topicCadence",
            topic.source AS "topicSource", topic.effective_at AS "topicEffectiveAt"
     FROM marketplace.communication_preference_sets sets
     LEFT JOIN marketplace.communication_channel_preferences channel
       ON channel.user_id = sets.user_id AND channel.organization_id = sets.organization_id
      AND channel.channel = 'email'
     LEFT JOIN marketplace.communication_topic_preferences topic
       ON topic.user_id = sets.user_id AND topic.organization_id = sets.organization_id
      AND topic.topic = 'collaboration_action_required' AND topic.channel = 'email'
     WHERE sets.user_id = $1::uuid AND sets.organization_id = $2::uuid`,
    [scope.userId, scope.organizationId],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw new Error("Communication preference aggregate is not unique");
  const row = result.rows[0]!;
  const email = effectiveStoredValue(
    row.emailState,
    row.emailSource,
    row.emailEffectiveAt,
    defaults.email,
    "state",
  );
  const topic = effectiveStoredValue(
    row.topicCadence,
    row.topicSource,
    row.topicEffectiveAt,
    defaults.topics.collaborationActionRequired,
    "cadence",
  );
  const parsed = parseMarketplaceCommunicationPreferences({
    contractVersion: MARKETPLACE_COMMUNICATIONS_CONTRACT_VERSION,
    organizationId: row.organizationId,
    revision: Number(row.revision),
    email,
    topics: { collaborationActionRequired: topic },
  });
  if (!parsed) throw new Error("Communication preference aggregate is incomplete or malformed");
  return parsed;
}

async function findReplay(
  client: MarketplaceCommunicationPreferencesClient,
  command: ReplaceMarketplaceCommunicationPreferencesCommand,
  keyHash: string,
  fingerprint: string,
  at: Date,
): Promise<ReplaceMarketplaceCommunicationPreferencesResult | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT id::text AS id, status, request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode", response_body_hash AS "responseBodyHash",
            response_resource_product AS "responseResourceProduct",
            response_resource_type AS "responseResourceType",
            response_resource_id AS "responseResourceId",
            idempotency_metadata AS "idempotencyMetadata", expires_at AS "expiresAt"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'marketplace' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'organization' AND organization_id = $3::uuid AND property_id IS NULL
     FOR UPDATE`,
    [OPERATION, keyHash, command.organizationId],
  );
  const row = result.rows[0];
  if (!row || new Date(row.expiresAt) <= at) return null;
  if (row.requestFingerprintHash !== fingerprint) return failed("idempotency_conflict");
  if (row.status !== "completed") return failed("command_in_progress");
  const resultValue = isRecord(row.idempotencyMetadata)
    ? row.idempotencyMetadata["result"]
    : undefined;
  const parsed = parseReplaceMarketplaceCommunicationPreferencesResult(resultValue);
  const resourceMatches = parsed?.ok
    ? row.responseResourceProduct === "marketplace" &&
      row.responseResourceType === RESOURCE_TYPE &&
      row.responseResourceId === command.userId
    : row.responseResourceProduct === null &&
      row.responseResourceType === null &&
      row.responseResourceId === null;
  return parsed &&
    resourceMatches &&
    row.responseStatusCode === statusCode(parsed) &&
    row.responseBodyHash === sha256(JSON.stringify(parsed))
    ? parsed
    : failed("idempotency_conflict");
}

async function reserveIdempotency(
  client: MarketplaceCommunicationPreferencesClient,
  command: ReplaceMarketplaceCommunicationPreferencesCommand,
  keyHash: string,
  fingerprint: string,
  at: Date,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, organization_id, correlation_id, first_seen_at, last_seen_at,
       expires_at, idempotency_metadata
     ) VALUES (
       'marketplace', $1, $2, $3, 'in_progress', 'organization', $4::uuid, $5,
       $6::timestamptz, $6::timestamptz, $6::timestamptz + interval '90 days', '{}'::jsonb
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO UPDATE SET
       request_fingerprint_hash = EXCLUDED.request_fingerprint_hash, status = 'in_progress',
       response_status_code = NULL, response_body_hash = NULL,
       response_resource_product = NULL, response_resource_type = NULL,
       response_resource_id = NULL, completed_at = NULL, last_seen_at = EXCLUDED.last_seen_at,
       expires_at = EXCLUDED.expires_at, idempotency_metadata = '{}'::jsonb
     WHERE idempotency_keys.expires_at <= EXCLUDED.first_seen_at
     RETURNING id::text AS id`,
    [
      OPERATION,
      keyHash,
      fingerprint,
      command.organizationId,
      command.audit.correlationId ?? command.audit.requestId,
      at.toISOString(),
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function lockAggregate(
  client: MarketplaceCommunicationPreferencesClient,
  command: { organizationId: string; userId: string },
): Promise<{ id: string; revision: number } | null> {
  const result = await client.query<{ id: string; revision: number | string }>(
    `SELECT id::text AS id, revision
     FROM marketplace.communication_preference_sets
     WHERE user_id = $1::uuid AND organization_id = $2::uuid FOR UPDATE`,
    [command.userId, command.organizationId],
  );
  if (result.rows.length > 1) throw new Error("Communication preference aggregate is not unique");
  const row = result.rows[0];
  return row ? { id: row.id, revision: Number(row.revision) } : null;
}

async function findUnsubscribeReplay(
  client: MarketplaceCommunicationPreferencesClient,
  command: MarketplaceCommunicationUnsubscribeCommand,
): Promise<boolean> {
  const result = await client.query<{
    status: string;
    requestFingerprintHash: string;
    responseStatusCode: number | null;
    responseBodyHash: string | null;
  }>(
    `SELECT status, request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode", response_body_hash AS "responseBodyHash"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'marketplace' AND operation = $1 AND key_hash = $2
       AND tenant_scope = 'organization' AND organization_id = $3::uuid AND property_id IS NULL
     FOR UPDATE`,
    [UNSUBSCRIBE_OPERATION, command.tokenHash, command.claims.organizationId],
  );
  const row = result.rows[0];
  if (!row) return false;
  if (
    row.status !== "completed" ||
    row.requestFingerprintHash !== command.tokenHash ||
    row.responseStatusCode !== 204 ||
    row.responseBodyHash !== sha256("")
  )
    throw new Error("Unsubscribe replay record is invalid");
  return true;
}

async function reserveUnsubscribe(
  client: MarketplaceCommunicationPreferencesClient,
  command: MarketplaceCommunicationUnsubscribeCommand,
  at: Date,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash, status,
       tenant_scope, organization_id, correlation_id, first_seen_at, last_seen_at,
       expires_at, idempotency_metadata
     ) VALUES (
       'marketplace', $1, $2, $2, 'in_progress', 'organization', $3::uuid, $4,
       $5::timestamptz, $5::timestamptz, $6::timestamptz, '{}'::jsonb
     ) ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      UNSUBSCRIBE_OPERATION,
      command.tokenHash,
      command.claims.organizationId,
      command.audit.correlationId ?? command.audit.requestId,
      at.toISOString(),
      new Date(command.claims.expiresAt * 1_000).toISOString(),
    ],
  );
  return result.rows[0]?.id ?? null;
}

async function readStoredTopic(
  client: MarketplaceCommunicationPreferencesClient,
  command: MarketplaceCommunicationUnsubscribeCommand,
): Promise<{ cadence: string; source: string } | null> {
  const result = await client.query<{ cadence: string; source: string }>(
    `SELECT cadence, source FROM marketplace.communication_topic_preferences
     WHERE user_id = $1::uuid AND organization_id = $2::uuid
       AND topic = 'collaboration_action_required' AND channel = 'email'`,
    [command.claims.userId, command.claims.organizationId],
  );
  if (result.rows.length > 1) throw new Error("Communication topic preference is not unique");
  return result.rows[0] ?? null;
}

async function persistTopicUnsubscribe(
  client: MarketplaceCommunicationPreferencesClient,
  command: MarketplaceCommunicationUnsubscribeCommand,
  current: { id: string; revision: number } | null,
  at: Date,
): Promise<number> {
  const common = [command.claims.userId, command.claims.organizationId, at.toISOString()];
  const revision = current ? current.revision + 1 : 1;
  if (current) {
    const updated = await client.query(
      `UPDATE marketplace.communication_preference_sets
       SET revision = revision + 1, updated_by_user_id = $1::uuid, updated_at = $3::timestamptz
       WHERE id = $4::uuid AND user_id = $1::uuid AND organization_id = $2::uuid
         AND revision = $5`,
      [...common, current.id, current.revision],
    );
    if (updated.rowCount !== 1) throw new Error("Unsubscribe revision update failed");
  } else {
    const inserted = await client.query(
      `INSERT INTO marketplace.communication_preference_sets (
         user_id, organization_id, revision, updated_by_user_id, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, 1, $1::uuid, $3::timestamptz, $3::timestamptz)`,
      common,
    );
    if (inserted.rowCount !== 1) throw new Error("Unsubscribe aggregate insert failed");
  }
  const topic = await client.query(
    `INSERT INTO marketplace.communication_topic_preferences (
       user_id, organization_id, topic, channel, cadence, source, consent_classification,
       consent_reference, effective_revision, policy_version, effective_at, updated_by_user_id,
       created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, 'collaboration_action_required', 'email', 'off',
       'signed_unsubscribe', 'service', NULL, $4, '${MARKETPLACE_COMMUNICATIONS_CONTRACT_VERSION}',
       $3::timestamptz, $1::uuid, $3::timestamptz, $3::timestamptz
     ) ON CONFLICT (user_id, organization_id, topic, channel) DO UPDATE SET
       cadence = 'off', source = 'signed_unsubscribe', consent_classification = 'service',
       consent_reference = NULL, effective_revision = EXCLUDED.effective_revision,
       policy_version = EXCLUDED.policy_version, effective_at = EXCLUDED.effective_at,
       updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = EXCLUDED.updated_at`,
    [...common, revision],
  );
  if (topic.rowCount !== 1) throw new Error("Unsubscribe topic preference write failed");
  return revision;
}

async function persistPreferences(
  client: MarketplaceCommunicationPreferencesClient,
  command: ReplaceMarketplaceCommunicationPreferencesCommand,
  preferenceSetId: string | null,
  before: MarketplaceCommunicationPreferencesV1 | null,
  at: Date,
): Promise<boolean> {
  const channelChanged =
    !before ||
    before.email.state !== command.request.email.state ||
    before.email.source !== "settings";
  const topicChanged =
    !before ||
    before.topics.collaborationActionRequired.cadence !==
      command.request.topics.collaborationActionRequired.cadence ||
    before.topics.collaborationActionRequired.source !== "settings";
  if (!channelChanged && !topicChanged) return false;
  const revision = command.request.expectedRevision + 1;
  const common = [
    command.userId,
    command.organizationId,
    command.audit.actorUserId,
    at.toISOString(),
  ];
  if (preferenceSetId) {
    const updated = await client.query(
      `UPDATE marketplace.communication_preference_sets
       SET revision = revision + 1, updated_by_user_id = $3::uuid, updated_at = $4::timestamptz
       WHERE id = $5::uuid AND user_id = $1::uuid AND organization_id = $2::uuid
         AND revision = $6`,
      [...common, preferenceSetId, command.request.expectedRevision],
    );
    if (updated.rowCount !== 1) throw new Error("Communication preference revision update failed");
  } else {
    const inserted = await client.query(
      `INSERT INTO marketplace.communication_preference_sets (
         user_id, organization_id, revision, updated_by_user_id, created_at, updated_at
       ) VALUES ($1::uuid, $2::uuid, 1, $3::uuid, $4::timestamptz, $4::timestamptz)`,
      common,
    );
    if (inserted.rowCount !== 1)
      throw new Error("Communication preference aggregate insert failed");
  }
  if (channelChanged) {
    const channel = await client.query(
      `INSERT INTO marketplace.communication_channel_preferences (
       user_id, organization_id, channel, state, source, effective_revision, policy_version,
       effective_at, updated_by_user_id, created_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, 'email', $5, 'settings', $6,
               '${MARKETPLACE_COMMUNICATIONS_CONTRACT_VERSION}', $4::timestamptz, $3::uuid,
               $4::timestamptz, $4::timestamptz)
     ON CONFLICT (user_id, organization_id, channel) DO UPDATE SET
       state = EXCLUDED.state, source = EXCLUDED.source,
       effective_revision = EXCLUDED.effective_revision, policy_version = EXCLUDED.policy_version,
       effective_at = EXCLUDED.effective_at, updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = EXCLUDED.updated_at`,
      [...common, command.request.email.state, revision],
    );
    if (channel.rowCount !== 1) throw new Error("Communication channel preference write failed");
  }
  if (topicChanged) {
    const topic = await client.query(
      `INSERT INTO marketplace.communication_topic_preferences (
       user_id, organization_id, topic, channel, cadence, source, consent_classification,
       consent_reference, effective_revision, policy_version, effective_at, updated_by_user_id,
       created_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, 'collaboration_action_required', 'email', $5, 'settings',
               'service', NULL, $6, '${MARKETPLACE_COMMUNICATIONS_CONTRACT_VERSION}',
               $4::timestamptz, $3::uuid, $4::timestamptz, $4::timestamptz)
     ON CONFLICT (user_id, organization_id, topic, channel) DO UPDATE SET
       cadence = EXCLUDED.cadence, source = EXCLUDED.source,
       consent_classification = EXCLUDED.consent_classification,
       consent_reference = EXCLUDED.consent_reference,
       effective_revision = EXCLUDED.effective_revision, policy_version = EXCLUDED.policy_version,
       effective_at = EXCLUDED.effective_at, updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = EXCLUDED.updated_at`,
      [...common, command.request.topics.collaborationActionRequired.cadence, revision],
    );
    if (topic.rowCount !== 1) throw new Error("Communication topic preference write failed");
  }
  return true;
}

async function recordAudit(
  client: MarketplaceCommunicationPreferencesClient,
  command: ReplaceMarketplaceCommunicationPreferencesCommand,
  idempotencyId: string,
  result: ReplaceMarketplaceCommunicationPreferencesResult,
  changed: boolean,
  at: Date,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, action_version, occurred_at, recorded_at, tenant_scope,
       organization_id, actor_type, actor_user_id, target_resource_product,
       target_resource_type, target_resource_id, idempotency_key_id, correlation_id,
       causation_id, redacted_payload, privacy_scope
     ) VALUES (
       $1, 'marketplace', $2, 1, $3::timestamptz, $3::timestamptz, 'organization',
       $4::uuid, 'user', $5::uuid, 'marketplace', $6, $7, $8::uuid, $9, $10,
       $11::jsonb, 'confidential'
     )`,
    [
      `marketplace.communication_preferences.organization.${command.organizationId}.user.${command.userId}.idempotency.${idempotencyId}.${at.getTime()}`,
      result.ok
        ? changed
          ? "marketplace.communication_preferences.updated"
          : "marketplace.communication_preferences.unchanged"
        : "marketplace.communication_preferences.replace_rejected",
      at.toISOString(),
      command.organizationId,
      command.audit.actorUserId,
      RESOURCE_TYPE,
      command.userId,
      idempotencyId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify(
        result.ok
          ? { outcome: changed ? "updated" : "unchanged", revision: result.preferences.revision }
          : { outcome: "rejected", errorCode: result.error.code },
      ),
    ],
  );
  if (inserted.rowCount !== 1) throw new Error("Communication preference audit insert failed");
}

async function completeIdempotency(
  client: MarketplaceCommunicationPreferencesClient,
  id: string,
  userId: string,
  result: ReplaceMarketplaceCommunicationPreferencesResult,
  at: Date,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys SET status = 'completed', response_status_code = $2,
       response_body_hash = $3, response_resource_product = $4,
       response_resource_type = $5, response_resource_id = $6,
       last_seen_at = $7::timestamptz, completed_at = $7::timestamptz,
       idempotency_metadata = jsonb_build_object('result', $8::jsonb)
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      id,
      statusCode(result),
      sha256(JSON.stringify(result)),
      result.ok ? "marketplace" : null,
      result.ok ? RESOURCE_TYPE : null,
      result.ok ? userId : null,
      at.toISOString(),
      JSON.stringify(result),
    ],
  );
  if (completed.rowCount !== 1) throw new Error("Communication preference idempotency failed");
}

async function recordUnsubscribeAudit(
  client: MarketplaceCommunicationPreferencesClient,
  command: MarketplaceCommunicationUnsubscribeCommand,
  idempotencyId: string,
  revision: number,
  changed: boolean,
  at: Date,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, action_version, occurred_at, recorded_at, tenant_scope,
       organization_id, actor_type, actor_user_id, target_resource_product,
       target_resource_type, target_resource_id, idempotency_key_id, correlation_id,
       causation_id, redacted_payload, privacy_scope
     ) VALUES (
       $1, 'marketplace', $2, 1, $3::timestamptz, $3::timestamptz, 'organization',
       $4::uuid, 'user', $5::uuid, 'marketplace', $6, $5::uuid::text, $7::uuid, $8, $9,
       $10::jsonb, 'confidential'
     )`,
    [
      `marketplace.communication_preferences.unsubscribe.idempotency.${idempotencyId}`,
      changed
        ? "marketplace.communication_preferences.topic_unsubscribed"
        : "marketplace.communication_preferences.topic_unsubscribe_unchanged",
      at.toISOString(),
      command.claims.organizationId,
      command.claims.userId,
      RESOURCE_TYPE,
      idempotencyId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify({
        outcome: changed ? "updated" : "unchanged",
        revision,
        deliveryId: command.claims.deliveryId,
        topic: command.claims.topic,
        channel: command.claims.channel,
      }),
    ],
  );
  if (inserted.rowCount !== 1) throw new Error("Unsubscribe audit insert failed");
}

async function completeUnsubscribe(
  client: MarketplaceCommunicationPreferencesClient,
  id: string,
  at: Date,
): Promise<void> {
  const completed = await client.query(
    `UPDATE platform.idempotency_keys SET status = 'completed', response_status_code = 204,
       response_body_hash = $2, last_seen_at = $3::timestamptz,
       completed_at = $3::timestamptz, idempotency_metadata = '{}'::jsonb
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [id, sha256(""), at.toISOString()],
  );
  if (completed.rowCount !== 1) throw new Error("Unsubscribe idempotency completion failed");
}

function effectiveStoredValue(
  value: unknown,
  source: unknown,
  effectiveAt: Date | string | null,
  defaults: object,
  valueKey: "state" | "cadence",
): object {
  if (value === null && source === null && effectiveAt === null) return defaults;
  if (value === null || source === null || effectiveAt === null) {
    throw new Error("Communication preference value is incomplete");
  }
  return { [valueKey]: value, source, effectiveAt: iso(effectiveAt) };
}

function validateUnsubscribeCommand(
  command: MarketplaceCommunicationUnsubscribeCommand,
  acceptedAt: Date,
): void {
  if (
    !validDate(acceptedAt) ||
    !validDate(new Date(command.audit.requestedAt)) ||
    command.claims.expiresAt <= Math.floor(acceptedAt.getTime() / 1_000) ||
    !UUID.test(command.claims.deliveryId) ||
    !UUID.test(command.claims.organizationId) ||
    !UUID.test(command.claims.userId) ||
    command.claims.action !== "unsubscribe_topic" ||
    command.claims.channel !== "email" ||
    command.claims.topic !== "collaboration_action_required" ||
    !/^[0-9a-f]{64}$/.test(command.tokenHash) ||
    !command.audit.requestId ||
    command.audit.requestId.length > 500 ||
    (command.audit.correlationId?.length ?? 0) > 500
  )
    throw new TypeError("Marketplace unsubscribe command envelope is invalid");
}

function validateCommandEnvelope(
  command: ReplaceMarketplaceCommunicationPreferencesCommand,
  acceptedAt: Date,
): void {
  if (
    !validDate(acceptedAt) ||
    !validDate(new Date(command.audit.requestedAt)) ||
    !command.idempotencyKey.trim() ||
    command.idempotencyKey.length > 255
  )
    throw new TypeError("Communication preference command envelope is invalid");
}
function failed(
  code: "idempotency_conflict" | "command_in_progress" | "scope_forbidden",
): ReplaceMarketplaceCommunicationPreferencesResult;
function failed(
  code: "preference_conflict",
  currentRevision: number,
): ReplaceMarketplaceCommunicationPreferencesResult;
function failed(
  code: string,
  currentRevision?: number,
): ReplaceMarketplaceCommunicationPreferencesResult {
  return code === "preference_conflict"
    ? { ok: false, error: { code, currentRevision: currentRevision! } }
    : {
        ok: false,
        error: {
          code: code as "idempotency_conflict" | "command_in_progress" | "scope_forbidden",
        },
      };
}
const statusCode = (result: ReplaceMarketplaceCommunicationPreferencesResult): number =>
  result.ok ? 200 : result.error.code === "scope_forbidden" ? 403 : 409;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const validDate = (value: Date): boolean => !Number.isNaN(value.getTime());
const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const lockUnavailable = (error: unknown): boolean => {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code: unknown }).code
      : null;
  return code === "55P03" || code === "57014";
};
const foreignKeyViolation = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && "code" in error && error.code === "23503");
async function rollbackQuietly(client: MarketplaceCommunicationPreferencesClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction failure.
  }
}
