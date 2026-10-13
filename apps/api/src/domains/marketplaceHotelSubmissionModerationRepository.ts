import { createHash } from "node:crypto";

import type { HotelMediaResolutionPort, MarketplaceModerationStatus } from "@vayada/domain-hotels";
import {
  MARKETPLACE_HOTEL_SUBMISSION_MODERATION_CONTRACT_VERSION,
  type MarketplaceHotelSubmissionDecisionCommand,
  type MarketplaceHotelSubmissionDecisionResponse,
  type MarketplaceHotelSubmissionDecisionResult,
  type MarketplaceHotelSubmissionModerationErrorCode,
} from "@vayada/domain-marketplace";
import pg, { type PoolClient } from "pg";

import {
  parseMarketplaceSubmissionCatalog,
  projectMarketplaceSubmission,
  type MarketplacePublicHotel,
} from "./marketplacePublicHotel.js";

const OPERATION = "marketplace.hotel_submission.decide";
const ENTITLEMENT = { product: "marketplace", key: "marketplace-hotel-profile" } as const;

export type MarketplaceHotelSubmissionQueueItem = {
  revisionId: string;
  propertyId: string;
  revisionNumber: number;
  submittedAt: string;
  displayName: string | null;
  propertyType: string | null;
  city: string | null;
  countryCode: string | null;
  /** Outcome of the hotel's previous submission, if any. */
  previous: { status: MarketplaceModerationStatus; decidedAt: string | null } | null;
  /** True while an earlier approved version is public. */
  live: boolean;
};

export type MarketplaceHotelSubmissionReview = {
  revisionId: string;
  propertyId: string;
  revisionNumber: number;
  status: MarketplaceModerationStatus;
  submittedAt: string;
  submittedByEmail: string | null;
  /** What /hotels/[id] will show after approval; null when the snapshot or its media can't be served. */
  preview: MarketplacePublicHotel | null;
  preferences: MarketplaceHotelSubmissionPreferences | null;
  history: {
    revisionId: string;
    revisionNumber: number;
    status: MarketplaceModerationStatus;
    submittedAt: string;
    decidedAt: string | null;
    note: string | null;
  }[];
  live: { revisionId: string; status: "active" | "suspended" | "deactivated" } | null;
};

export type MarketplaceHotelSubmissionPreferences = {
  compensationTypes: string[];
  contentPlatforms: string[];
  contentTypes: string[];
  availability: { mode: string; selectedMonths: number[] };
};

type Pool = { connect(): Promise<PoolClient>; end(): Promise<void> };

export function createPgMarketplaceHotelSubmissionModerationRepository(config: {
  connectionString: string;
  pool?: Pool;
}) {
  if (!config.connectionString.trim())
    throw new Error("Marketplace submission moderation connectionString is required");
  const pool: Pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: 4,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
    });

  async function read<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
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

  return {
    /** Pending latest submissions, oldest first. */
    async listPending(): Promise<MarketplaceHotelSubmissionQueueItem[]> {
      return read(async (client) => {
        const result = await client.query<QueueRow>(QUEUE_SQL);
        return result.rows.map((row) => ({
          revisionId: row.revisionId,
          propertyId: row.propertyId,
          revisionNumber: row.revisionNumber,
          submittedAt: iso(row.submittedAt),
          displayName: row.displayName,
          propertyType: row.propertyType,
          city: row.city,
          countryCode: row.countryCode,
          previous: row.previousStatus
            ? {
                status: row.previousStatus,
                decidedAt: row.previousDecidedAt ? iso(row.previousDecidedAt) : null,
              }
            : null,
          live: row.live,
        }));
      });
    },

    async getReview(
      revisionId: string,
      mediaResolver: HotelMediaResolutionPort | null,
    ): Promise<MarketplaceHotelSubmissionReview | null> {
      const loaded = await read(async (client) => {
        const result = await client.query<ReviewRow>(REVIEW_SQL, [revisionId]);
        const row = result.rows[0];
        if (!row) return null;
        const history = await client.query<HistoryRow>(HISTORY_SQL, [row.propertyId]);
        return { row, history: history.rows };
      });
      if (!loaded) return null;
      const { row, history } = loaded;
      let preview: MarketplacePublicHotel | null = null;
      try {
        if (mediaResolver)
          preview = await projectMarketplaceSubmission(mediaResolver, {
            propertyId: row.propertyId,
            revisionId: row.revisionId,
            organizationId: row.organizationId,
            snapshot: row.snapshot,
          });
      } catch {
        preview = null;
      }
      return {
        revisionId: row.revisionId,
        propertyId: row.propertyId,
        revisionNumber: row.revisionNumber,
        status: row.status,
        submittedAt: iso(row.submittedAt),
        submittedByEmail: row.submittedByEmail,
        preview,
        preferences: parsePreferences(isRecord(row.snapshot) ? row.snapshot.preferences : null),
        history: history.map((entry) => ({
          revisionId: entry.revisionId,
          revisionNumber: entry.revisionNumber,
          status: entry.status,
          submittedAt: iso(entry.submittedAt),
          decidedAt: entry.decidedAt ? iso(entry.decidedAt) : null,
          note: entry.note,
        })),
        live: row.liveRevisionId
          ? { revisionId: row.liveRevisionId, status: row.liveStatus! }
          : null,
      };
    },

    /** Approve (publish) or request changes on the latest pending submission. */
    async decide(
      command: MarketplaceHotelSubmissionDecisionCommand,
    ): Promise<MarketplaceHotelSubmissionDecisionResult> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout = '5s'");
        const result = await decide(client, command);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      if (!config.pool) await pool.end();
    },
  };
}

async function decide(
  client: PoolClient,
  command: MarketplaceHotelSubmissionDecisionCommand,
): Promise<MarketplaceHotelSubmissionDecisionResult> {
  const target = await client.query<{ propertyId: string; organizationId: string }>(
    `SELECT property_id::text AS "propertyId", organization_id::text AS "organizationId"
     FROM marketplace.hotel_submission_revisions WHERE id=$1::uuid`,
    [command.revisionId],
  );
  const scope = target.rows[0];
  if (!scope) return failure("submission_not_found");

  // Same lock order as owner submission and property lifecycle commands: property, then profile.
  const property = await client.query<{ lifecycleStatus: string }>(
    `SELECT lifecycle_status AS "lifecycleStatus" FROM hotel_catalog.properties
     WHERE id=$1::uuid FOR SHARE`,
    [scope.propertyId],
  );
  const profile = await client.query<{ status: string }>(
    `SELECT marketplace_profile_status AS status FROM marketplace.marketplace_hotel_profiles
     WHERE property_id=$1::uuid AND organization_id=$2::uuid FOR UPDATE`,
    [scope.propertyId, scope.organizationId],
  );
  const locked = await client.query<LockedSubmission>(
    `SELECT revision.revision_number AS "revisionNumber", revision.submission_snapshot AS snapshot,
            moderation.status,
            EXISTS (SELECT 1 FROM marketplace.hotel_submission_revisions newer
                    WHERE newer.property_id=revision.property_id
                      AND newer.revision_number>revision.revision_number) AS superseded
     FROM marketplace.hotel_submission_revisions revision
     JOIN marketplace.hotel_submission_moderation moderation
       ON moderation.submission_revision_id=revision.id AND moderation.property_id=revision.property_id
     WHERE revision.id=$1::uuid FOR UPDATE OF moderation`,
    [command.revisionId],
  );
  const submission = locked.rows[0];
  if (!submission || !property.rows[0] || !profile.rows[0]) return failure("submission_not_found");

  const keyHash = sha256(JSON.stringify([scope.propertyId, command.idempotencyKey]));
  const fingerprint = sha256(JSON.stringify([command.revisionId, command.request]));
  const replay = await client.query<{ fingerprint: string; response: unknown }>(
    `SELECT request_fingerprint_hash AS fingerprint, idempotency_metadata->'response' AS response
     FROM platform.idempotency_keys
     WHERE operation_scope='marketplace' AND operation=$1 AND key_hash=$2
       AND tenant_scope='property' AND property_id=$3::uuid FOR UPDATE`,
    [OPERATION, keyHash, scope.propertyId],
  );
  if (replay.rows[0]) {
    const stored = replay.rows[0];
    const response = parseResponse(stored.response, command.revisionId);
    return stored.fingerprint === fingerprint && response
      ? { ok: true, response }
      : failure("idempotency_key_conflict");
  }

  if (submission.status !== "pending") return failure("submission_already_decided");
  if (submission.superseded) return failure("submission_superseded");

  const approve = command.request.decision === "approve";
  if (approve) {
    // A new hotel may still be provisioning (VAY-2140 activates it); only a held property can't go public.
    if (["suspended", "retired"].includes(property.rows[0].lifecycleStatus))
      return failure("property_unavailable");
    if (!["pending", "verified"].includes(profile.rows[0].status))
      return failure("marketplace_profile_unavailable");
    const active = await client.query<{ status: string }>(
      `SELECT activation_status AS status FROM marketplace.active_hotel_submission_revisions
       WHERE property_id=$1::uuid FOR UPDATE`,
      [scope.propertyId],
    );
    if (active.rows[0] && active.rows[0].status !== "active")
      return failure("marketplace_publication_suspended");
    if (!(await hasActiveMarketplaceEntitlement(client, scope)))
      return failure("marketplace_entitlement_inactive");
    if (!parseMarketplaceSubmissionCatalog(submission.snapshot, scope.propertyId))
      return failure("submission_snapshot_invalid");
  }

  const at = new Date().toISOString();
  const note = command.request.decision === "request_changes" ? command.request.note : null;
  const status = approve ? "approved" : "changes_requested";
  const updated = await client.query(
    `UPDATE marketplace.hotel_submission_moderation
     SET status=$2, decided_by_user_id=$3::uuid, decision_reason=$4, decided_at=$5::timestamptz,
         updated_at=$5::timestamptz
     WHERE submission_revision_id=$1::uuid AND status='pending'`,
    [command.revisionId, status, command.audit.actorUserId, note, at],
  );
  if (updated.rowCount !== 1) throw new Error("Submission moderation lost its lock");
  if (approve) {
    await client.query(
      `INSERT INTO marketplace.active_hotel_submission_revisions (
         property_id, submission_revision_id, moderation_status, activation_status,
         activated_by_user_id, activated_at, status_changed_by_user_id, status_reason, updated_at
       ) VALUES ($1::uuid,$2::uuid,'approved','active',$3::uuid,$4::timestamptz,$3::uuid,NULL,$4::timestamptz)
       ON CONFLICT (property_id) DO UPDATE SET
         submission_revision_id=EXCLUDED.submission_revision_id, activation_status='active',
         activated_by_user_id=EXCLUDED.activated_by_user_id, activated_at=EXCLUDED.activated_at,
         status_changed_by_user_id=EXCLUDED.status_changed_by_user_id, status_reason=NULL,
         updated_at=EXCLUDED.updated_at`,
      [scope.propertyId, command.revisionId, command.audit.actorUserId, at],
    );
    // Keep the older profile status in step, so offer verification and the admin user page agree.
    await client.query(
      `UPDATE marketplace.marketplace_hotel_profiles
       SET marketplace_profile_status='verified', updated_at=$2::timestamptz
       WHERE property_id=$1::uuid AND marketplace_profile_status='pending'`,
      [scope.propertyId, at],
    );
  }

  const response: MarketplaceHotelSubmissionDecisionResponse = {
    contractVersion: MARKETPLACE_HOTEL_SUBMISSION_MODERATION_CONTRACT_VERSION,
    revisionId: command.revisionId,
    propertyId: scope.propertyId,
    revisionNumber: submission.revisionNumber,
    status,
    note,
    decidedByUserId: command.audit.actorUserId,
    decidedAt: at,
    publicPath: approve ? `/hotels/${scope.propertyId}` : null,
  };
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,
       target_resource_product,target_resource_type,target_resource_id,correlation_id,causation_id,
       redacted_payload,private_payload,audit_metadata,privacy_scope
     ) VALUES ($1,'marketplace',$2,$3::timestamptz,'property',$4::uuid,'user',$5::uuid,
       'marketplace','hotel_submission_revision',$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,'confidential')`,
    [
      `marketplace.submission.${command.revisionId}.decision.v1`,
      approve
        ? "marketplace.hotel_submission.approved"
        : "marketplace.hotel_submission.changes_requested",
      at,
      scope.propertyId,
      command.audit.actorUserId,
      command.revisionId,
      command.audit.correlationId ?? command.audit.requestId,
      command.audit.requestId,
      JSON.stringify({ revisionId: command.revisionId, revisionNumber: submission.revisionNumber }),
      JSON.stringify(note === null ? {} : { note }),
      JSON.stringify({
        contractVersion: response.contractVersion,
        actorOrganizationId: command.audit.actorOrganizationId,
        requestedAt: command.audit.requestedAt,
      }),
    ],
  );
  await client.query(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,
       correlation_id,first_seen_at,last_seen_at,completed_at,expires_at,response_status_code,
       response_body_hash,response_resource_product,response_resource_type,response_resource_id,
       idempotency_metadata
     ) VALUES ('marketplace',$1,$2,$3,'completed','property',$4::uuid,$5,$6::timestamptz,
       $6::timestamptz,$6::timestamptz,$6::timestamptz + interval '90 days',200,$7,'marketplace',
       'hotel_submission_revision',$8,jsonb_build_object('response',$9::jsonb))`,
    [
      OPERATION,
      keyHash,
      fingerprint,
      scope.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
      at,
      sha256(JSON.stringify(response)),
      command.revisionId,
      JSON.stringify(response),
    ],
  );
  return { ok: true, response };
}

/** Mirrors the setup-scope rule: an applicable active grant and no applicable suspension. */
async function hasActiveMarketplaceEntitlement(
  client: PoolClient,
  scope: { organizationId: string; propertyId: string },
): Promise<boolean> {
  const result = await client.query<{ status: string }>(
    `SELECT entitlement.status
     FROM identity.product_entitlements entitlement
     JOIN identity.organizations organization
       ON organization.id=entitlement.organization_id AND organization.status='active'
     WHERE entitlement.organization_id=$1::uuid AND entitlement.product=$3
       AND entitlement.entitlement_key=$4
       AND (entitlement.resource_product IS NULL
            OR (entitlement.resource_product=$3 AND entitlement.resource_type='hotel_profile'
                AND entitlement.resource_id=$2::uuid::text))
       AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
       AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())`,
    [scope.organizationId, scope.propertyId, ENTITLEMENT.product, ENTITLEMENT.key],
  );
  const statuses = result.rows.map((row) => row.status);
  return !statuses.includes("suspended") && statuses.includes("active");
}

type QueueRow = {
  revisionId: string;
  propertyId: string;
  revisionNumber: number;
  submittedAt: Date | string;
  displayName: string | null;
  propertyType: string | null;
  city: string | null;
  countryCode: string | null;
  previousStatus: MarketplaceModerationStatus | null;
  previousDecidedAt: Date | string | null;
  live: boolean;
};

const QUEUE_SQL = `
  SELECT revision.id::text AS "revisionId", revision.property_id::text AS "propertyId",
         revision.revision_number AS "revisionNumber", revision.submitted_at AS "submittedAt",
         revision.submission_snapshot #>> '{catalog,profile,displayName}' AS "displayName",
         revision.submission_snapshot #>> '{catalog,profile,propertyType}' AS "propertyType",
         revision.submission_snapshot #>> '{catalog,profile,location,city}' AS city,
         revision.submission_snapshot #>> '{catalog,profile,location,countryCode}' AS "countryCode",
         previous.status AS "previousStatus", previous.decided_at AS "previousDecidedAt",
         COALESCE(active.activation_status = 'active', FALSE) AS live
  FROM marketplace.hotel_submission_moderation moderation
  JOIN marketplace.hotel_submission_revisions revision
    ON revision.id = moderation.submission_revision_id AND revision.property_id = moderation.property_id
  LEFT JOIN LATERAL (
    SELECT earlier_moderation.status, earlier_moderation.decided_at
    FROM marketplace.hotel_submission_revisions earlier
    JOIN marketplace.hotel_submission_moderation earlier_moderation
      ON earlier_moderation.submission_revision_id = earlier.id
     AND earlier_moderation.property_id = earlier.property_id
    WHERE earlier.property_id = revision.property_id
      AND earlier.revision_number < revision.revision_number
    ORDER BY earlier.revision_number DESC
    LIMIT 1
  ) previous ON TRUE
  LEFT JOIN marketplace.active_hotel_submission_revisions active
    ON active.property_id = revision.property_id
  WHERE moderation.status = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM marketplace.hotel_submission_revisions newer
      WHERE newer.property_id = revision.property_id
        AND newer.revision_number > revision.revision_number
    )
  ORDER BY revision.submitted_at ASC, revision.id ASC
  LIMIT 200`;

type ReviewRow = {
  revisionId: string;
  propertyId: string;
  organizationId: string;
  revisionNumber: number;
  status: MarketplaceModerationStatus;
  submittedAt: Date | string;
  submittedByEmail: string | null;
  snapshot: unknown;
  liveRevisionId: string | null;
  liveStatus: "active" | "suspended" | "deactivated" | null;
};

const REVIEW_SQL = `
  SELECT revision.id::text AS "revisionId", revision.property_id::text AS "propertyId",
         revision.organization_id::text AS "organizationId",
         revision.revision_number AS "revisionNumber", moderation.status,
         revision.submitted_at AS "submittedAt", submitter.email AS "submittedByEmail",
         revision.submission_snapshot AS snapshot,
         active.submission_revision_id::text AS "liveRevisionId",
         active.activation_status AS "liveStatus"
  FROM marketplace.hotel_submission_revisions revision
  JOIN marketplace.hotel_submission_moderation moderation
    ON moderation.submission_revision_id = revision.id AND moderation.property_id = revision.property_id
  LEFT JOIN identity.users submitter ON submitter.id = revision.submitted_by_user_id
  LEFT JOIN marketplace.active_hotel_submission_revisions active
    ON active.property_id = revision.property_id
  WHERE revision.id = $1::uuid`;

type HistoryRow = {
  revisionId: string;
  revisionNumber: number;
  status: MarketplaceModerationStatus;
  submittedAt: Date | string;
  decidedAt: Date | string | null;
  note: string | null;
};

const HISTORY_SQL = `
  SELECT revision.id::text AS "revisionId", revision.revision_number AS "revisionNumber",
         moderation.status, revision.submitted_at AS "submittedAt",
         moderation.decided_at AS "decidedAt", moderation.decision_reason AS note
  FROM marketplace.hotel_submission_revisions revision
  JOIN marketplace.hotel_submission_moderation moderation
    ON moderation.submission_revision_id = revision.id AND moderation.property_id = revision.property_id
  WHERE revision.property_id = $1::uuid
  ORDER BY revision.revision_number DESC
  LIMIT 20`;

type LockedSubmission = {
  revisionNumber: number;
  snapshot: unknown;
  status: MarketplaceModerationStatus;
  superseded: boolean;
};

function parsePreferences(value: unknown): MarketplaceHotelSubmissionPreferences | null {
  if (!isRecord(value) || !isRecord(value.availability)) return null;
  const strings = (list: unknown) =>
    Array.isArray(list) && list.every((item) => typeof item === "string")
      ? (list as string[])
      : null;
  const compensationTypes = strings(value.compensationTypes);
  const contentPlatforms = strings(value.contentPlatforms);
  const contentTypes = strings(value.contentTypes);
  const { mode, selectedMonths } = value.availability;
  if (
    !compensationTypes ||
    !contentPlatforms ||
    !contentTypes ||
    typeof mode !== "string" ||
    !Array.isArray(selectedMonths) ||
    !selectedMonths.every((month) => Number.isInteger(month))
  )
    return null;
  return {
    compensationTypes,
    contentPlatforms,
    contentTypes,
    availability: { mode, selectedMonths: selectedMonths as number[] },
  };
}

function parseResponse(
  value: unknown,
  revisionId: string,
): MarketplaceHotelSubmissionDecisionResponse | null {
  if (!isRecord(value)) return null;
  if (
    value.contractVersion !== MARKETPLACE_HOTEL_SUBMISSION_MODERATION_CONTRACT_VERSION ||
    value.revisionId !== revisionId ||
    (value.status !== "approved" && value.status !== "changes_requested") ||
    typeof value.propertyId !== "string" ||
    typeof value.decidedAt !== "string"
  )
    return null;
  return value as MarketplaceHotelSubmissionDecisionResponse;
}

function failure(code: MarketplaceHotelSubmissionModerationErrorCode) {
  return { ok: false as const, error: { code } };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
