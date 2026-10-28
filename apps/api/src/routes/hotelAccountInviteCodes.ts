import { parsePreparedHotelImport, type PreparedHotelImport } from "@vayada/domain-hotels";
import { randomBytes } from "node:crypto";

import type { PermissionKey, RequestContext } from "@vayada/backend-auth";
import {
  OFFERED_SETUP_TRACKS,
  normalizeStoredSetupTracks,
  type SetupTrack,
} from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg, { type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import { enforceRoutePolicy } from "./policy.js";

// Hotel account invite codes, issued by platform staff in Vayada Admin and redeemed in Booking
// Admin (routes/hotelAccountInvites.ts). Carved out of the retired Marketplace admin routes
// (VAY-2270). The routes are served at `/api/platform/admin/invite-codes` since VAY-2302; the rows
// live in `hotel_catalog.hotel_account_invites` since migration 0496 (VAY-2272).

export const HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION = "hotel-account-invite.v1" as const;
export const HOTEL_ACCOUNT_INVITE_HANDOFF_PATH = "/setup" as const;

/** Stored on existing hotel organizations; the surface name is historical and must not change. */
export function hotelAccountInviteOrganizationExternalId(inviteId: string): string {
  return `vayada-signup:marketplace-web:hotel:invite:${inviteId}`;
}

export function hotelAccountInviteTrackCorrelationId(inviteId: string): string {
  return `hotel-account-invite:${inviteId}:tracks`;
}

const PLATFORM_ADMIN_PERMISSION = "platform.user.suspend" satisfies PermissionKey;

type PlatformAdminRouteAccess = {
  context: RequestContext;
};

export type HotelAccountInviteCode = {
  contractVersion: typeof HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION;
  id: string;
  code: string;
  status: "pending" | "redeemed" | "expired";
  createdAt: string;
  expiresAt: string;
  identity: HotelAccountInviteCreateRequest["identity"] | null;
  organization: HotelAccountInviteCreateRequest["organization"] | null;
  property: HotelAccountInviteCreateRequest["property"] | null;
  selectedTracks: SetupTrack[];
  handoffPath: typeof HOTEL_ACCOUNT_INVITE_HANDOFF_PATH;
  redeemedAt: string | null;
};

export type HotelAccountInviteCreateRequest = {
  preparedData?: PreparedHotelImport;
  identity: {
    email: string;
  };
  organization: {
    displayName: string;
  };
  property: {
    displayName: string;
  };
  selectedTracks: SetupTrack[];
};

type StoredHotelAccountInvitePayload = HotelAccountInviteCreateRequest & {
  contractVersion: typeof HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION;
  handoffPath: typeof HOTEL_ACCOUNT_INVITE_HANDOFF_PATH;
};

export type HotelAccountInviteCodeRepository = {
  listInviteCodes(): Promise<HotelAccountInviteCode[]>;
  createInviteCode(input: {
    invite: StoredHotelAccountInvitePayload;
    createdByUserId: string;
  }): Promise<HotelAccountInviteCode>;
  revokeInviteCode(inviteCodeId: string): Promise<boolean>;
  close?(): Promise<void>;
};

export type HotelAccountInviteCodeRoutesOptions = {
  repository: HotelAccountInviteCodeRepository;
};

type InviteCodePool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
};

export function createPgHotelAccountInviteCodeRepository(config: {
  connectionString: string;
  max?: number;
  pool?: InviteCodePool;
}): HotelAccountInviteCodeRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Hotel account invite code repository connectionString must not be empty");
  }

  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async listInviteCodes() {
      const result = await pool.query<InviteCodeRow>(
        `${INVITE_CODE_SELECT_SQL}
         WHERE invite.invite_type = 'hotel'
           AND invite.payload ->> 'contractVersion' = $1
           AND invite.status <> 'revoked'
         ORDER BY invite.created_at DESC, invite.id`,
        [HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION],
      );
      return result.rows.map(toInviteCode);
    },
    async createInviteCode(input) {
      const result = await pool.query<InviteCodeRow>(
        `WITH invite AS (
           INSERT INTO hotel_catalog.hotel_account_invites (
             code,
             invite_type,
             status,
             payload,
             created_by_user_id,
             expires_at
           )
           VALUES ($1, 'hotel', 'pending', $2::jsonb, $3::uuid, now() + interval '30 days')
           RETURNING *
         )
         ${INVITE_CODE_SELECT_BODY}`,
        [
          `VAY-${randomBytes(24).toString("base64url")}`,
          JSON.stringify(input.invite),
          input.createdByUserId,
        ],
      );
      return toInviteCode(result.rows[0]!);
    },
    async revokeInviteCode(inviteCodeId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const invite = await client.query<{ id: string }>(
          `SELECT id::text AS id
           FROM hotel_catalog.hotel_account_invites
           WHERE id::text = $1
             AND invite_type = 'hotel'
             AND payload ->> 'contractVersion' = $2
             AND status <> 'redeemed'
           FOR UPDATE`,
          [inviteCodeId, HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION],
        );
        if (!invite.rows[0]) {
          await client.query("ROLLBACK");
          return false;
        }

        const redemption = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1
             FROM platform.idempotency_keys redemption
             JOIN identity.organizations organization
               ON organization.id = redemption.organization_id
             WHERE redemption.operation_scope = 'hotel_catalog'
               AND redemption.operation = 'hotel_setup.tracks.update'
               AND redemption.correlation_id = $1
               AND redemption.tenant_scope = 'organization'
               AND redemption.status = 'completed'
               AND redemption.response_status_code = 200
               AND organization.workos_external_id = $2
           ) AS exists`,
          [
            hotelAccountInviteTrackCorrelationId(inviteCodeId),
            hotelAccountInviteOrganizationExternalId(inviteCodeId),
          ],
        );
        if (redemption.rows[0]?.exists) {
          await client.query("ROLLBACK");
          return false;
        }

        const result = await client.query<{ id: string }>(
          `UPDATE hotel_catalog.hotel_account_invites
           SET status = 'revoked'
           WHERE id::text = $1
             AND status <> 'redeemed'
           RETURNING id::text AS id`,
          [inviteCodeId],
        );
        await client.query("COMMIT");
        return Boolean(result.rows[0]);
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

export async function registerHotelAccountInviteCodeRoutes(
  app: FastifyInstance,
  options: HotelAccountInviteCodeRoutesOptions,
): Promise<void> {
  const { repository } = options;

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get("/admin/invite-codes", async (request) => {
    await requirePlatformAdminAccess(request);
    return repository.listInviteCodes();
  });

  app.post<{ Body: unknown }>("/admin/invite-codes", async (request, reply) => {
    const access = await requirePlatformAdminAccess(request);
    const parsed = parseHotelAccountInviteCreateRequest(request.body);
    if (typeof parsed === "string") return sendAdminError(reply, 422, parsed);
    const inviteCode = await repository.createInviteCode({
      invite: {
        contractVersion: HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION,
        ...parsed,
        handoffPath: HOTEL_ACCOUNT_INVITE_HANDOFF_PATH,
      },
      createdByUserId: access.context.actor.internalUserId,
    });
    return reply.status(201).send(inviteCode);
  });

  app.delete<{ Params: InviteCodeParams }>(
    "/admin/invite-codes/:inviteCodeId",
    async (request, reply) => {
      await requirePlatformAdminAccess(request);
      const revoked = await repository.revokeInviteCode(request.params.inviteCodeId);
      if (!revoked) return sendAdminError(reply, 404, "invite_code_not_found");
      return reply.status(204).send();
    },
  );
}

async function requirePlatformAdminAccess(
  request: FastifyRequest,
): Promise<PlatformAdminRouteAccess> {
  const context = enforceRoutePolicy(request, {
    permission: PLATFORM_ADMIN_PERMISSION,
    resource: {
      product: "platform",
      resourceType: "platform",
      resourceId: "vayada",
      allowedRelationships: ["operator"],
    },
  });
  return { context };
}

const HOTEL_ACCOUNT_INVITE_REQUEST_KEYS = [
  "identity",
  "organization",
  "property",
  "selectedTracks",
] as const;
const HOTEL_ACCOUNT_INVITE_PAYLOAD_KEYS = [
  "contractVersion",
  ...HOTEL_ACCOUNT_INVITE_REQUEST_KEYS,
  "handoffPath",
] as const;
const HOTEL_ACCOUNT_INVITE_REDEMPTION_KEY = "redemption";
const INVITE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export function parseHotelAccountInviteCreateRequest(
  body: unknown,
): HotelAccountInviteCreateRequest | string {
  if (!isRecord(body)) return "invite_body_required";
  if (!hasOnlyKeys(body, [...HOTEL_ACCOUNT_INVITE_REQUEST_KEYS, "preparedData"])) {
    return "unsupported_invite_field";
  }
  if (!isRecord(body.identity) || !hasOnlyKeys(body.identity, ["email"])) {
    return "invalid_invite_identity";
  }
  if (!isRecord(body.organization) || !hasOnlyKeys(body.organization, ["displayName"])) {
    return "invalid_invite_organization";
  }
  if (!isRecord(body.property) || !hasOnlyKeys(body.property, ["displayName"])) {
    return "invalid_invite_property";
  }

  const email = readInviteText(body.identity.email, 254)?.toLowerCase();
  const organizationName = readInviteText(body.organization.displayName, 160);
  const propertyName = readInviteText(body.property.displayName, 160);
  if (!email || !INVITE_EMAIL_PATTERN.test(email)) return "invalid_invite_email";
  if (!organizationName) return "invalid_invite_organization";
  if (!propertyName) return "invalid_invite_property";
  if (
    !Array.isArray(body.selectedTracks) ||
    body.selectedTracks.length === 0 ||
    body.selectedTracks.length > OFFERED_SETUP_TRACKS.length ||
    body.selectedTracks.some(
      (track) => !(OFFERED_SETUP_TRACKS as readonly unknown[]).includes(track),
    )
  ) {
    return "invalid_selected_tracks";
  }

  const preparedData =
    body.preparedData === undefined ? undefined : parsePreparedHotelImport(body.preparedData);
  if (preparedData === null) return "invalid_prepared_data";
  if (preparedData?.rooms.length && !body.selectedTracks.includes("hotel_operations"))
    return "rooms_require_hotel_operations";
  const uniqueTracks = new Set<SetupTrack>(body.selectedTracks as SetupTrack[]);
  if (uniqueTracks.size !== body.selectedTracks.length) return "invalid_selected_tracks";
  const selectedTracks: SetupTrack[] = [];
  if (uniqueTracks.has("hotel_operations")) selectedTracks.push("hotel_operations");

  return {
    ...(preparedData ? { preparedData } : {}),
    identity: { email },
    organization: { displayName: organizationName },
    property: { displayName: propertyName },
    selectedTracks,
  };
}

/**
 * Stored invites may still name the retired Creator Marketplace track (VAY-2270). They are read as
 * Hotel Operations invites: that is the only track a hotel can set up now.
 */
export function storedHotelAccountInviteTracks(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const tracks = normalizeStoredSetupTracks(value);
  return tracks.length > 0 ? tracks : ["hotel_operations"];
}

function parseStoredHotelAccountInvite(value: unknown): StoredHotelAccountInvitePayload | null {
  if (!isRecord(value)) return null;
  const hasRedemption = Object.prototype.hasOwnProperty.call(
    value,
    HOTEL_ACCOUNT_INVITE_REDEMPTION_KEY,
  );
  const allowedKeys = [
    ...HOTEL_ACCOUNT_INVITE_PAYLOAD_KEYS,
    ...(hasRedemption ? [HOTEL_ACCOUNT_INVITE_REDEMPTION_KEY] : []),
    ...(Object.hasOwn(value, "preparedData") ? ["preparedData"] : []),
  ];
  if (Object.keys(value).length !== allowedKeys.length || !hasOnlyKeys(value, allowedKeys)) {
    return null;
  }
  if (hasRedemption) {
    const redemption = value.redemption;
    if (
      !isRecord(redemption) ||
      Object.keys(redemption).length !== 1 ||
      !hasOnlyKeys(redemption, ["organizationId"]) ||
      typeof redemption.organizationId !== "string"
    ) {
      return null;
    }
  }
  if (
    value.contractVersion !== HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION ||
    value.handoffPath !== HOTEL_ACCOUNT_INVITE_HANDOFF_PATH
  ) {
    return null;
  }
  const parsed = parseHotelAccountInviteCreateRequest({
    identity: value.identity,
    organization: value.organization,
    property: value.property,
    selectedTracks: storedHotelAccountInviteTracks(value.selectedTracks),
    ...(Object.hasOwn(value, "preparedData") ? { preparedData: value.preparedData } : {}),
  });
  if (typeof parsed === "string") return null;
  return {
    contractVersion: HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION,
    ...parsed,
    handoffPath: HOTEL_ACCOUNT_INVITE_HANDOFF_PATH,
  };
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function readInviteText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximumLength ||
    INVITE_CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function sendAdminError(reply: FastifyReply, statusCode: 404 | 409 | 422, code: string) {
  return reply.status(statusCode).send({
    statusCode,
    code,
    category: statusCode === 404 ? "not_found" : statusCode === 409 ? "conflict" : "validation",
    message: code,
  });
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original write error.
  }
}

function toInviteCode(row: InviteCodeRow): HotelAccountInviteCode {
  const status =
    row.status === "redeemed" ? "redeemed" : row.status === "expired" ? "expired" : "pending";
  const invite = parseStoredHotelAccountInvite(row.payload);
  return {
    contractVersion: HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION,
    id: row.id,
    code: row.code,
    status,
    createdAt: toIsoString(row.createdAt),
    expiresAt: toIsoString(row.expiresAt),
    identity: invite?.identity ?? null,
    organization: invite?.organization ?? null,
    property: invite?.property ?? null,
    selectedTracks: invite?.selectedTracks ?? [],
    handoffPath: HOTEL_ACCOUNT_INVITE_HANDOFF_PATH,
    redeemedAt: toIsoStringOrNull(row.redeemedAt),
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoStringOrNull(value: unknown): string | null {
  if (!value) return null;
  return value instanceof Date || typeof value === "string" ? toIsoString(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type InviteCodeParams = {
  inviteCodeId: string;
};

type InviteCodeRow = {
  id: string;
  code: string;
  status: string;
  createdAt: Date | string;
  expiresAt: Date | string;
  redeemedAt: Date | string | null;
  payload: unknown;
};

const INVITE_CODE_SELECT_BODY = `
  SELECT
    invite.id::text AS id,
    invite.code,
    invite.status,
    invite.created_at AS "createdAt",
    invite.expires_at AS "expiresAt",
    invite.redeemed_at AS "redeemedAt",
    invite.payload
  FROM invite
`;

const INVITE_CODE_SELECT_SQL = `
  WITH invite AS (
    SELECT *
    FROM hotel_catalog.hotel_account_invites invite
  )
  ${INVITE_CODE_SELECT_BODY}
`;
