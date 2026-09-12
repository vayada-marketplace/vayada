import type { HotelMediaResolutionPort } from "@vayada/domain-hotels";
import { readMarketplacePublicHotel } from "./marketplacePublicHotel.js";
import { createHash, randomUUID } from "node:crypto";
import type { MarketplaceHotelCollaborationPreferencesCommandAudit } from "@vayada/domain-marketplace";
import {
  createReadyProductReadinessEvidence,
  type MarketplaceModerationStatus,
  type MarketplaceActivationStatus,
} from "@vayada/domain-hotels";
import pg from "pg";
import { lockHotelCatalogSetupScope } from "./hotelCatalogStep1Repository.js";
import {
  lockMarketplaceHotelProfileForSetup,
  type MarketplaceHotelCollaborationPreferencesClient as Client,
} from "./marketplaceHotelCollaborationPreferencesRepository.js";
import type { MarketplaceSubmissionReadinessPort } from "./marketplaceSubmissionReadiness.js";

const OPERATION = "marketplace.hotel_submission.submit";
export type MarketplaceSubmissionScope = {
  organizationId: string;
  propertyId: string;
  audit: MarketplaceHotelCollaborationPreferencesCommandAudit;
};
export type SubmitMarketplaceRequest = {
  expectedLatestSubmissionRevisionId: string | null;
  expectedSourceManifestHash: string;
  expectedReadinessHash: string;
};
export type MarketplaceSubmissionReceipt = {
  revisionId: string;
  propertyId: string;
  revisionNumber: number;
  status: MarketplaceModerationStatus;
  submittedAt: string;
  decisionReason: string | null;
};
export class MarketplaceSubmissionError extends Error {
  constructor(
    readonly code: string,
    readonly status: number = 409,
  ) {
    super(code);
  }
}
export function createPgMarketplaceSubmissionRepository(config: {
  connectionString: string;
  sources: (client: Client) => MarketplaceSubmissionReadinessPort;
  pool?: { connect(): Promise<Client>; end(): Promise<void> };
}) {
  if (!config.connectionString.trim())
    throw new Error("Marketplace submission connectionString is required");
  const pool: { connect(): Promise<Client>; end(): Promise<void> } =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: 4,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });
  async function transaction<T>(
    scope: MarketplaceSubmissionScope,
    run: (client: Client) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      if (
        scope.audit.actor.kind !== "user" ||
        !(await lockHotelCatalogSetupScope(client, {
          organizationId: scope.organizationId,
          propertyId: scope.propertyId,
          actorUserId: scope.audit.actor.userId,
        })) ||
        !(await lockMarketplaceHotelProfileForSetup(client, scope, new Date()))
      )
        throw new MarketplaceSubmissionError("setup_scope_unavailable", 403);
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  function sourceScope(scope: MarketplaceSubmissionScope) {
    if (scope.audit.actor.kind !== "user")
      throw new MarketplaceSubmissionError("setup_scope_unavailable", 403);
    return {
      organizationId: scope.organizationId,
      propertyId: scope.propertyId,
      actorUserId: scope.audit.actor.userId,
    };
  }
  return {
    async getPublicHotel(propertyId: string, mediaResolver: HotelMediaResolutionPort) {
      const client = await pool.connect();
      try {
        return await readMarketplacePublicHotel(client, mediaResolver, propertyId);
      } finally {
        client.release();
      }
    },
    async submit(
      scope: MarketplaceSubmissionScope,
      idempotencyKey: string,
      request: SubmitMarketplaceRequest,
    ): Promise<MarketplaceSubmissionReceipt> {
      if (
        !idempotencyKey.trim() ||
        idempotencyKey.length > 200 ||
        !/^sha256:[0-9a-f]{64}$/.test(request.expectedSourceManifestHash) ||
        !/^sha256:[0-9a-f]{64}$/.test(request.expectedReadinessHash) ||
        !(
          request.expectedLatestSubmissionRevisionId === null ||
          uuid(request.expectedLatestSubmissionRevisionId)
        )
      )
        throw new MarketplaceSubmissionError("invalid_submission_request", 400);
      const keyHash = hash(JSON.stringify([scope.organizationId, idempotencyKey]));
      const fingerprint = hash(
        JSON.stringify([
          scope.organizationId,
          scope.propertyId,
          request.expectedLatestSubmissionRevisionId,
          request.expectedSourceManifestHash,
          request.expectedReadinessHash,
        ]),
      );
      return transaction(scope, async (client) => {
        const replay = await client.query<{
          fingerprint: string;
          response: MarketplaceSubmissionReceipt;
          status: string;
          responseHash: string;
        }>(
          `SELECT status, response_body_hash AS "responseHash", request_fingerprint_hash AS fingerprint, idempotency_metadata->'response' AS response FROM platform.idempotency_keys WHERE operation_scope='marketplace' AND operation=$1 AND key_hash=$2 AND tenant_scope='property' AND property_id=$3::uuid FOR UPDATE`,
          [OPERATION, keyHash, scope.propertyId],
        );
        if (replay.rows[0]) {
          const stored = replay.rows[0];
          if (
            stored.fingerprint !== fingerprint ||
            stored.status !== "completed" ||
            !stored.response ||
            stored.response.propertyId !== scope.propertyId ||
            !uuid(stored.response.revisionId) ||
            stored.response.status !== "pending" ||
            !Number.isSafeInteger(stored.response.revisionNumber) ||
            stored.response.revisionNumber < 1 ||
            stored.responseHash !== receiptHash(stored.response)
          )
            throw new MarketplaceSubmissionError("idempotency_key_conflict");
          return stored.response;
        }
        const latest = await latestSubmission(client, scope);
        if ((latest?.revisionId ?? null) !== request.expectedLatestSubmissionRevisionId)
          throw new MarketplaceSubmissionError("submission_revision_conflict");
        if (latest?.status === "pending")
          throw new MarketplaceSubmissionError("submission_pending_review");
        const evaluation = await config.sources(client).evaluate(sourceScope(scope));
        if (
          evaluation.readiness.status !== "ready" ||
          evaluation.readiness.sourceManifestHash !== request.expectedSourceManifestHash ||
          evaluation.readiness.readinessHash !== request.expectedReadinessHash
        )
          throw new MarketplaceSubmissionError("invalid_readiness_evidence");
        const readiness = await createReadyProductReadinessEvidence(evaluation.readiness, {
          propertyId: scope.propertyId,
          product: "marketplace",
        });
        const revisionId = randomUUID();
        const at = new Date().toISOString();
        const receipt: MarketplaceSubmissionReceipt = {
          revisionId,
          propertyId: scope.propertyId,
          revisionNumber: (latest?.revisionNumber ?? 0) + 1,
          status: "pending",
          submittedAt: at,
          decisionReason: null,
        };
        await client.query(
          `INSERT INTO marketplace.hotel_submission_revisions (id,property_id,organization_id,revision_number,readiness_contract_version,source_manifest,source_manifest_hash,readiness_hash,readiness_product,readiness_status,submission_snapshot,submitted_by_user_id,submitted_at) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7,$8,'marketplace','ready',$9::jsonb,$10::uuid,$11::timestamptz)`,
          [
            revisionId,
            scope.propertyId,
            scope.organizationId,
            receipt.revisionNumber,
            readiness.contractVersion,
            JSON.stringify(readiness.sourceManifest),
            readiness.sourceManifestHash,
            readiness.readinessHash,
            JSON.stringify(evaluation.snapshot),
            sourceScope(scope).actorUserId,
            at,
          ],
        );
        await client.query(
          `INSERT INTO marketplace.hotel_submission_moderation (submission_revision_id,property_id,status,updated_at) VALUES ($1::uuid,$2::uuid,'pending',$3::timestamptz)`,
          [revisionId, scope.propertyId, at],
        );
        await client.query(
          `INSERT INTO platform.idempotency_keys (operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,correlation_id,first_seen_at,last_seen_at,completed_at,expires_at,response_status_code,response_body_hash,response_resource_product,response_resource_type,response_resource_id,idempotency_metadata) VALUES ('marketplace',$1,$2,$3,'completed','property',$4::uuid,$5,$6::timestamptz,$6::timestamptz,$6::timestamptz,$6::timestamptz+interval '90 days',201,$7,'marketplace','hotel_submission_revision',$8,jsonb_build_object('response',$9::jsonb))`,
          [
            OPERATION,
            keyHash,
            fingerprint,
            scope.propertyId,
            scope.audit.correlationId ?? scope.audit.requestId,
            at,
            receiptHash(receipt),
            revisionId,
            JSON.stringify(receipt),
          ],
        );
        await client.query(
          `INSERT INTO platform.product_audit_events (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,target_resource_product,target_resource_type,target_resource_id,correlation_id,causation_id,redacted_payload,audit_metadata,privacy_scope) VALUES ($1,'marketplace','marketplace.hotel_submission.submitted',$2::timestamptz,'property',$3::uuid,'user',$4::uuid,'marketplace','hotel_submission_revision',$5,$6,$7,$8::jsonb,'{}'::jsonb,'confidential')`,
          [
            `marketplace.submission.${revisionId}.v1`,
            at,
            scope.propertyId,
            sourceScope(scope).actorUserId,
            revisionId,
            scope.audit.correlationId ?? scope.audit.requestId,
            scope.audit.requestId,
            JSON.stringify({
              revisionId,
              revisionNumber: receipt.revisionNumber,
              sourceManifestHash: readiness.sourceManifestHash,
            }),
          ],
        );
        return receipt;
      });
    },
    async getReview(scope: MarketplaceSubmissionScope, idempotencyKey?: string) {
      return transaction(scope, async (client) => {
        const latest = await latestSubmission(client, scope);
        let recovered: MarketplaceSubmissionReceipt | null = null;
        if (idempotencyKey) {
          const result = await client.query<{ revisionId: string }>(
            `SELECT response_resource_id AS "revisionId" FROM platform.idempotency_keys WHERE operation_scope='marketplace' AND operation=$1 AND key_hash=$2 AND tenant_scope='property' AND property_id=$3::uuid`,
            [
              OPERATION,
              hash(JSON.stringify([scope.organizationId, idempotencyKey])),
              scope.propertyId,
            ],
          );
          if (result.rows[0])
            recovered = await readSubmission(client, scope, result.rows[0].revisionId);
        }
        const active = await client.query<{
          revisionId: string;
          status: MarketplaceActivationStatus;
        }>(
          `SELECT active.submission_revision_id::text AS "revisionId", active.activation_status AS status FROM marketplace.active_hotel_submission_revisions active JOIN marketplace.hotel_submission_revisions revision ON revision.id=active.submission_revision_id AND revision.property_id=active.property_id WHERE active.property_id=$1::uuid AND revision.organization_id=$2::uuid`,
          [scope.propertyId, scope.organizationId],
        );
        const readiness = await config.sources(client).getReadiness(sourceScope(scope));
        return {
          contractVersion: "marketplace-submission-review.v1" as const,
          propertyId: scope.propertyId,
          latestSubmission: latest,
          recoveredSubmission: recovered,
          activeSubmission: active.rows[0] ?? null,
          readiness,
        };
      });
    },
    async close() {
      if (!config.pool) await pool.end();
    },
  };
}
async function latestSubmission(client: Client, scope: MarketplaceSubmissionScope) {
  return readSubmission(client, scope);
}
async function readSubmission(
  client: Client,
  scope: MarketplaceSubmissionScope,
  revisionId?: string,
): Promise<MarketplaceSubmissionReceipt | null> {
  const result = await client.query<{
    revisionId: string;
    propertyId: string;
    revisionNumber: number;
    status: MarketplaceModerationStatus;
    submittedAt: Date | string;
    decisionReason: string | null;
  }>(
    `SELECT revision.id::text AS "revisionId",revision.property_id::text AS "propertyId",revision.revision_number AS "revisionNumber",moderation.status,revision.submitted_at AS "submittedAt",moderation.decision_reason AS "decisionReason" FROM marketplace.hotel_submission_revisions revision JOIN marketplace.hotel_submission_moderation moderation ON moderation.submission_revision_id=revision.id AND moderation.property_id=revision.property_id WHERE revision.property_id=$1::uuid AND revision.organization_id=$2::uuid AND ($3::uuid IS NULL OR revision.id=$3::uuid) ORDER BY revision.revision_number DESC LIMIT 1`,
    [scope.propertyId, scope.organizationId, revisionId ?? null],
  );
  const row = result.rows[0];
  return row ? { ...row, submittedAt: new Date(row.submittedAt).toISOString() } : null;
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function uuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function receiptHash(receipt: MarketplaceSubmissionReceipt): string {
  return hash(
    JSON.stringify([
      receipt.revisionId,
      receipt.propertyId,
      receipt.revisionNumber,
      receipt.status,
      receipt.submittedAt,
      receipt.decisionReason,
    ]),
  );
}
