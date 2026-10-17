import { parsePreparedHotelImport, type PreparedHotelImport } from "@vayada/domain-hotels";
import { createHash, randomBytes } from "node:crypto";

import { requireAuthContext, type PermissionKey, type RequestContext } from "@vayada/backend-auth";
import { isSetupTrack, type SetupTrack } from "@vayada/domain-hotels";
import {
  parseMarketplaceOfferMatchingCriteria,
  parseMarketplaceOfferMatchingCriteriaWrite,
  type MarketplaceOfferMatchingCriteria,
  type MarketplaceOfferMatchingCriteriaWrite,
  type MarketplaceOfferRequirementLevel,
} from "@vayada/domain-marketplace";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg, { type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import {
  ensureCanonicalPropertySlug,
  PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE,
} from "../platform/publicBookabilityPublication.js";
import { enforceRoutePolicy } from "./policy.js";

export const MARKETPLACE_ADMIN_CONTRACT_VERSION = "marketplace-admin.v1" as const;
export const HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION = "hotel-account-invite.v1" as const;
export const HOTEL_ACCOUNT_INVITE_HANDOFF_PATH = "/setup" as const;

export function hotelAccountInviteOrganizationExternalId(inviteId: string): string {
  return `vayada-signup:marketplace-web:hotel:invite:${inviteId}`;
}

export function hotelAccountInviteTrackCorrelationId(inviteId: string): string {
  return `hotel-account-invite:${inviteId}:tracks`;
}

const MARKETPLACE_ADMIN_PERMISSION = "platform.user.suspend" satisfies PermissionKey;

export type MarketplaceAdminAuthorizationMode =
  | "platform_organization_membership"
  | "legacy_superadmin_fallback";

export type MarketplaceAdminRouteAccess = {
  context: RequestContext;
  authorizationMode: MarketplaceAdminAuthorizationMode;
};

export type MarketplacePlatformName =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "facebook"
  | "blog"
  | "x"
  | "other";

export type MarketplaceOfferCompensationOptionWrite = {
  compensationType: "free_stay" | "paid" | "discount" | "affiliate";
  availabilityMonths: string[];
  platforms: MarketplacePlatformName[];
  freeStayMinNights: number | null;
  freeStayMaxNights: number | null;
  paidMaxAmount: string | null;
  discountPercentage: number | null;
  commissionPercentage: number | null;
  minFollowers: number | null;
  followerRequirementLevel?: MarketplaceOfferRequirementLevel | null;
  currency: string | null;
  termsSummary: string | null;
};

export type MarketplaceOfferCreatorRequirementsWrite = {
  platforms: MarketplacePlatformName[];
  platformRequirementLevel?: MarketplaceOfferRequirementLevel | null;
  targetCountries: string[];
  targetCountriesRequirementLevel?: MarketplaceOfferRequirementLevel | null;
  targetAgeMin: number | null;
  targetAgeMax: number | null;
  targetAgeGroups: string[];
  creatorTypes: ("lifestyle" | "travel" | "other")[];
  creatorTypesRequirementLevel?: MarketplaceOfferRequirementLevel | null;
};

export type MarketplaceOfferDeliverableWrite = {
  platform: MarketplacePlatformName;
  deliverableType: string;
  quantity: number;
  timingGuidance?: string | null;
  requirementLevel?: MarketplaceOfferRequirementLevel | null;
};

export type MarketplaceAdminCreateOfferRequest = {
  title: string;
  offerSummary?: string | null;
  deliverables: MarketplaceOfferDeliverableWrite[];
  compensationOptions: MarketplaceOfferCompensationOptionWrite[];
  creatorRequirements: MarketplaceOfferCreatorRequirementsWrite;
  matchingCriteria?: MarketplaceOfferMatchingCriteriaWrite | null;
};

export type MarketplaceAdminUpdateOfferRequest = Partial<
  Omit<
    MarketplaceAdminCreateOfferRequest,
    "deliverables" | "compensationOptions" | "creatorRequirements"
  >
> & {
  deliverables?: MarketplaceOfferDeliverableWrite[];
  compensationOptions?: MarketplaceOfferCompensationOptionWrite[];
  creatorRequirements?: MarketplaceOfferCreatorRequirementsWrite | null;
  matchingCriteria?: MarketplaceOfferMatchingCriteriaWrite | null;
};

export type MarketplaceAdminInviteCode = {
  contractVersion: typeof HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION;
  id: string;
  code: string;
  status: "pending" | "redeemed" | "expired";
  createdAt: string;
  expiresAt: string;
  identity: MarketplaceAdminHotelAccountInviteCreateRequest["identity"] | null;
  organization: MarketplaceAdminHotelAccountInviteCreateRequest["organization"] | null;
  property: MarketplaceAdminHotelAccountInviteCreateRequest["property"] | null;
  selectedTracks: SetupTrack[];
  handoffPath: typeof HOTEL_ACCOUNT_INVITE_HANDOFF_PATH;
  redeemedAt: string | null;
};

export type MarketplaceAdminHotelAccountInviteCreateRequest = {
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

type MarketplaceAdminHotelAccountInvitePayload = MarketplaceAdminHotelAccountInviteCreateRequest & {
  contractVersion: typeof HOTEL_ACCOUNT_INVITE_CONTRACT_VERSION;
  handoffPath: typeof HOTEL_ACCOUNT_INVITE_HANDOFF_PATH;
};

export type MarketplaceAdminOffer = {
  contractVersion: typeof MARKETPLACE_ADMIN_CONTRACT_VERSION;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  offerId: string;
  propertyId: string;
  offerStatus: "draft" | "pending" | "verified" | "rejected" | "suspended" | "archived";
  title: string;
  offerSummary: string | null;
  media: MarketplaceAdminOfferMedia[];
  deliverables: (MarketplaceOfferDeliverableWrite & { deliverableId: string })[];
  compensationOptions: (MarketplaceOfferCompensationOptionWrite & {
    compensationOptionId: string;
  })[];
  creatorRequirements: MarketplaceOfferCreatorRequirementsWrite | null;
  matchingCriteria: MarketplaceOfferMatchingCriteria | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceAdminOfferMedia = {
  mediaObjectId: string | null;
  url: string | null;
  approvalStatus: "pending_domain_approval" | "approved";
  lifecycleStatus: "staged" | "active";
};

export type MarketplaceOfferWriteAudit = {
  actorUserId: string;
  actorOrganizationId: string;
  requestId: string;
  correlationId: string | null;
  source: RequestContext["audit"]["source"];
  occurredAt: string;
};

export type MarketplaceAdminRepository = {
  listInviteCodes(): Promise<MarketplaceAdminInviteCode[]>;
  createInviteCode(input: {
    invite: MarketplaceAdminHotelAccountInvitePayload;
    createdByUserId: string;
  }): Promise<MarketplaceAdminInviteCode>;
  revokeInviteCode(inviteCodeId: string): Promise<boolean>;
  isLegacySuperadmin?(userId: string): Promise<boolean>;
  close?(): Promise<void>;
};

export type MarketplaceAdminRoutesOptions = {
  repository: MarketplaceAdminRepository;
  legacySuperadminFallbackEnabled?: boolean;
};

type MarketplaceAdminPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
};

export function createPgMarketplaceAdminRepository(config: {
  connectionString: string;
  max?: number;
  pool?: MarketplaceAdminPool;
}): MarketplaceAdminRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Marketplace admin repository connectionString must not be empty");
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
           INSERT INTO marketplace.invite_codes (
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
           FROM marketplace.invite_codes
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
          `UPDATE marketplace.invite_codes
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
    async isLegacySuperadmin(userId) {
      const hasColumn = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'users'
             AND column_name = 'is_superadmin'
         )`,
      );
      if (!hasColumn.rows[0]?.exists) return false;
      const result = await pool.query<{ is_superadmin: boolean }>(
        `SELECT is_superadmin
         FROM public.users
         WHERE id::text = $1
         LIMIT 1`,
        [userId],
      );
      return result.rows[0]?.is_superadmin === true;
    },
    async close() {
      await pool.end();
    },
  };
}

export async function registerMarketplaceAdminRoutes(
  app: FastifyInstance,
  options: MarketplaceAdminRoutesOptions,
): Promise<void> {
  const { repository } = options;

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get("/admin/invite-codes", async (request) => {
    await requireMarketplaceAdminAccess(request, options);
    return repository.listInviteCodes();
  });

  app.post<{ Body: unknown }>("/admin/invite-codes", async (request, reply) => {
    const access = await requireMarketplaceAdminAccess(request, options);
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
      await requireMarketplaceAdminAccess(request, options);
      const revoked = await repository.revokeInviteCode(request.params.inviteCodeId);
      if (!revoked) return sendAdminError(reply, 404, "invite_code_not_found");
      return reply.status(204).send();
    },
  );
}

async function requireMarketplaceAdminAccess(
  request: FastifyRequest,
  options: MarketplaceAdminRoutesOptions,
): Promise<MarketplaceAdminRouteAccess> {
  try {
    const context = enforceRoutePolicy(request, {
      permission: MARKETPLACE_ADMIN_PERMISSION,
      resource: {
        product: "platform",
        resourceType: "platform",
        resourceId: "vayada",
        allowedRelationships: ["operator"],
      },
    });
    return { context, authorizationMode: "platform_organization_membership" };
  } catch (error) {
    if (!options.legacySuperadminFallbackEnabled) throw error;
    const context = requireAuthContext(request);
    if (await options.repository.isLegacySuperadmin?.(context.actor.internalUserId)) {
      return { context, authorizationMode: "legacy_superadmin_fallback" };
    }
    throw error;
  }
}

export function offerWriteAudit(context: RequestContext): MarketplaceOfferWriteAudit {
  return {
    actorUserId: context.actor.internalUserId,
    actorOrganizationId: context.selectedOrganization.organizationId,
    requestId: context.audit.requestId,
    correlationId: context.audit.correlationId ?? null,
    source: context.audit.source,
    occurredAt: context.audit.receivedAt,
  };
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
): MarketplaceAdminHotelAccountInviteCreateRequest | string {
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
    body.selectedTracks.length > 2 ||
    body.selectedTracks.some((track) => !isSetupTrack(track))
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
  if (uniqueTracks.has("creator_marketplace")) selectedTracks.push("creator_marketplace");

  return {
    ...(preparedData ? { preparedData } : {}),
    identity: { email },
    organization: { displayName: organizationName },
    property: { displayName: propertyName },
    selectedTracks,
  };
}

function parseStoredHotelAccountInvite(
  value: unknown,
): MarketplaceAdminHotelAccountInvitePayload | null {
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
    selectedTracks: value.selectedTracks,
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

export function validateCreateOfferRequest(
  body: MarketplaceAdminCreateOfferRequest | undefined,
): string | null {
  if (!body || !readNonEmptyString(body.title)) return "title_required";
  if (!Array.isArray(body.deliverables)) {
    return "deliverables_required";
  }
  if (!Array.isArray(body.compensationOptions)) {
    return "compensation_options_required";
  }
  if (!body.creatorRequirements) return "creator_requirements_required";
  return validateOfferChildren(
    body.deliverables,
    body.compensationOptions,
    body.creatorRequirements,
    body.matchingCriteria,
  );
}

export function validateUpdateOfferRequest(
  body: MarketplaceAdminUpdateOfferRequest | undefined,
): string | null {
  if (!body) return "body_required";
  if (body.title !== undefined && !readNonEmptyString(body.title)) return "title_required";
  return validateOfferChildren(
    body.deliverables,
    body.compensationOptions,
    body.creatorRequirements,
    body.matchingCriteria,
  );
}

function validateOfferChildren(
  deliverables?: MarketplaceOfferDeliverableWrite[],
  compensationOptions?: MarketplaceOfferCompensationOptionWrite[],
  requirements?: MarketplaceOfferCreatorRequirementsWrite | null,
  matchingCriteria?: MarketplaceOfferMatchingCriteriaWrite | null,
): string | null {
  if (deliverables) {
    for (const deliverable of deliverables) {
      if (!readNonEmptyString(deliverable.deliverableType)) return "invalid_deliverable";
      if (!isPositiveInteger(deliverable.quantity)) return "invalid_deliverable";
      if (!isOptionalRequirementLevel(deliverable.requirementLevel)) {
        return "invalid_deliverable_requirement_level";
      }
    }
  }
  if (compensationOptions) {
    for (const option of compensationOptions) {
      if (!["free_stay", "paid", "discount", "affiliate"].includes(option.compensationType)) {
        return "invalid_compensation_type";
      }
      if (option.compensationType === "free_stay") {
        if (
          !isPositiveInteger(option.freeStayMinNights) ||
          !isPositiveInteger(option.freeStayMaxNights) ||
          option.freeStayMinNights > option.freeStayMaxNights
        ) {
          return "invalid_free_stay";
        }
      }
      if (option.compensationType === "paid" && !isPositiveDecimalString(option.paidMaxAmount)) {
        return "invalid_paid_amount";
      }
      if (option.compensationType === "discount" && !isPercentage(option.discountPercentage)) {
        return "invalid_discount";
      }
      if (option.compensationType === "affiliate" && !isPercentage(option.commissionPercentage)) {
        return "invalid_commission";
      }
      if (!isOptionalRequirementLevel(option.followerRequirementLevel)) {
        return "invalid_follower_requirement_level";
      }
      if (
        option.followerRequirementLevel &&
        (!isPositiveInteger(option.minFollowers) ||
          !Array.isArray(option.platforms) ||
          option.platforms.length === 0 ||
          option.platforms.some((platform) => !toPlatformName(platform)))
      ) {
        return "invalid_follower_requirement";
      }
    }
  }
  if (requirements) {
    if (
      !Array.isArray(requirements.platforms) ||
      !Array.isArray(requirements.targetCountries) ||
      !Array.isArray(requirements.creatorTypes)
    ) {
      return "invalid_requirements";
    }
    const selections = [
      [requirements.platformRequirementLevel, requirements.platforms],
      [requirements.targetCountriesRequirementLevel, requirements.targetCountries],
      [requirements.creatorTypesRequirementLevel, requirements.creatorTypes],
    ] as const;
    if (
      selections.some(
        ([level, values]) =>
          !isOptionalRequirementLevel(level) || (level === "required" && values.length === 0),
      )
    ) {
      return "invalid_requirement_level";
    }
    if (
      requirements.platformRequirementLevel === "required" &&
      deliverables &&
      requirements.platforms.some(
        (platform) => !deliverables.some((deliverable) => deliverable.platform === platform),
      )
    ) {
      return "inconsistent_requirement_platforms";
    }
  }
  const parsedCriteria =
    matchingCriteria === undefined || matchingCriteria === null
      ? matchingCriteria
      : parseMarketplaceOfferMatchingCriteriaWrite(matchingCriteria);
  if (matchingCriteria !== undefined && matchingCriteria !== null && !parsedCriteria) {
    return "invalid_matching_criteria";
  }
  if (parsedCriteria?.expectedCompensationValue && compensationOptions) {
    const currencies = new Set(compensationOptions.map((option) => option.currency ?? "USD"));
    if (!currencies.has(parsedCriteria.expectedCompensationValue.currency)) {
      return "inconsistent_compensation_currency";
    }
  }
  return null;
}

export class MarketplaceOfferConsistencyError extends Error {
  readonly statusCode = 422;

  constructor(readonly code: string) {
    super(code);
    this.name = "MarketplaceOfferConsistencyError";
  }
}

export function validateMergedOfferUpdate(
  current: MarketplaceAdminOffer,
  request: MarketplaceAdminUpdateOfferRequest,
): string | null {
  if (current.offerStatus !== "draft") {
    if (request.deliverables?.length === 0) return "deliverables_required";
    if (request.compensationOptions?.length === 0) return "compensation_options_required";
  }
  return validateOfferChildren(
    request.deliverables ?? current.deliverables,
    request.compensationOptions ?? current.compensationOptions,
    request.creatorRequirements === undefined
      ? current.creatorRequirements
      : request.creatorRequirements,
    request.matchingCriteria === undefined
      ? matchingCriteriaWrite(current.matchingCriteria ?? null)
      : request.matchingCriteria,
  );
}

function matchingCriteriaWrite(
  criteria: MarketplaceOfferMatchingCriteria | null,
): MarketplaceOfferMatchingCriteriaWrite | null {
  if (!criteria) return null;
  return {
    primaryCampaignGoal: criteria.primaryCampaignGoal,
    availability: criteria.availability,
    contentCategories: criteria.contentCategories,
    contentStyles: criteria.contentStyles,
    usageRights: criteria.usageRights,
    includedRevisionRounds: criteria.includedRevisionRounds,
    expectedEffortHours: criteria.expectedEffortHours,
    expectedCompensationValue: criteria.expectedCompensationValue,
    applicationCapacity: criteria.applicationCapacity,
  };
}

function isOptionalRequirementLevel(value: unknown): boolean {
  return value === undefined || value === null || value === "required" || value === "preferred";
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

export async function replaceOfferChildren(
  client: Pick<MarketplaceAdminPool, "query">,
  input: {
    offerId: string;
    propertyId: string;
    organizationId: string;
    deliverables?: MarketplaceOfferDeliverableWrite[];
    compensationOptions?: MarketplaceOfferCompensationOptionWrite[];
    creatorRequirements?: MarketplaceOfferCreatorRequirementsWrite | null;
    matchingCriteria?: MarketplaceOfferMatchingCriteriaWrite | null;
    actorUserId?: string;
  },
): Promise<void> {
  if (input.deliverables !== undefined) {
    await client.query(`DELETE FROM marketplace.offer_deliverables WHERE offer_id = $1`, [
      input.offerId,
    ]);
    for (const deliverable of input.deliverables) {
      await client.query(
        `INSERT INTO marketplace.offer_deliverables (
           offer_id,
           property_id,
           organization_id,
           platform,
           deliverable_type,
           quantity,
           timing_guidance,
           requirement_level
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.offerId,
          input.propertyId,
          input.organizationId,
          deliverable.platform,
          deliverable.deliverableType,
          deliverable.quantity,
          deliverable.timingGuidance ?? null,
          deliverable.requirementLevel ?? null,
        ],
      );
    }
  }

  if (input.compensationOptions !== undefined) {
    await client.query(`DELETE FROM marketplace.offer_compensation_options WHERE offer_id = $1`, [
      input.offerId,
    ]);
    for (const option of input.compensationOptions) {
      await client.query(
        `INSERT INTO marketplace.offer_compensation_options (
           offer_id,
           property_id,
           organization_id,
           compensation_type,
           availability_months,
           platforms,
           free_stay_min_nights,
           free_stay_max_nights,
           paid_max_amount,
           discount_percentage,
           commission_percentage,
           min_followers,
           currency,
           terms_summary,
           follower_requirement_level
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11::numeric, $12, $13, $14, $15)`,
        [
          input.offerId,
          input.propertyId,
          input.organizationId,
          option.compensationType,
          option.availabilityMonths,
          option.platforms,
          option.freeStayMinNights,
          option.freeStayMaxNights,
          option.paidMaxAmount,
          option.discountPercentage,
          option.commissionPercentage,
          option.minFollowers,
          option.currency ?? "USD",
          option.termsSummary,
          option.followerRequirementLevel ?? null,
        ],
      );
    }
  }

  if (input.creatorRequirements !== undefined) {
    await client.query(`DELETE FROM marketplace.offer_creator_requirements WHERE offer_id = $1`, [
      input.offerId,
    ]);
    if (input.creatorRequirements) {
      await client.query(
        `INSERT INTO marketplace.offer_creator_requirements (
           offer_id,
           property_id,
           organization_id,
           platforms,
           target_countries,
           target_age_min,
           target_age_max,
           target_age_groups,
           creator_types,
           platform_requirement_level,
           target_countries_requirement_level,
           creator_types_requirement_level
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          input.offerId,
          input.propertyId,
          input.organizationId,
          input.creatorRequirements.platforms,
          input.creatorRequirements.targetCountries,
          input.creatorRequirements.targetAgeMin,
          input.creatorRequirements.targetAgeMax,
          input.creatorRequirements.targetAgeGroups,
          input.creatorRequirements.creatorTypes,
          input.creatorRequirements.platformRequirementLevel ?? null,
          input.creatorRequirements.targetCountriesRequirementLevel ?? null,
          input.creatorRequirements.creatorTypesRequirementLevel ?? null,
        ],
      );
    }
  }

  if (input.matchingCriteria !== undefined) {
    if (input.matchingCriteria === null) {
      await client.query(`DELETE FROM marketplace.offer_matching_criteria WHERE offer_id = $1`, [
        input.offerId,
      ]);
    } else {
      if (!input.actorUserId) {
        throw new Error("Marketplace offer matching criteria require an audit actor");
      }
      await client.query(
        `INSERT INTO marketplace.offer_matching_criteria (
           offer_id, property_id, organization_id, contract_version, criteria,
           updated_by_user_id
         ) VALUES (
           $1, $2, $3, 'marketplace-offer-matching-criteria.v1', $4::jsonb, $5::uuid
         )
         ON CONFLICT (offer_id) DO UPDATE
         SET criteria = EXCLUDED.criteria,
             revision = marketplace.offer_matching_criteria.revision + 1,
             updated_by_user_id = EXCLUDED.updated_by_user_id,
             updated_at = now()`,
        [
          input.offerId,
          input.propertyId,
          input.organizationId,
          JSON.stringify(input.matchingCriteria),
          input.actorUserId,
        ],
      );
    }
  }
}

export async function recordOfferMatchingAudit(
  client: Pick<MarketplaceAdminPool, "query">,
  input: {
    action: "created" | "updated";
    offerId: string;
    propertyId: string;
    request: MarketplaceAdminCreateOfferRequest | MarketplaceAdminUpdateOfferRequest;
    audit: MarketplaceOfferWriteAudit;
  },
): Promise<void> {
  const changedFields = [
    "deliverables",
    "compensationOptions",
    "creatorRequirements",
    "matchingCriteria",
  ].filter((field) => input.request[field as keyof typeof input.request] !== undefined);
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id,
       actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, correlation_id, causation_id, redacted_payload,
       audit_metadata, privacy_scope
     ) VALUES (
       $1, 'marketplace', $2, $3::timestamptz, 'property', $4::uuid,
       'user', $5::uuid, 'marketplace', 'marketplace_offer', $6, $7, $8,
       $9::jsonb, $10::jsonb, 'internal'
     )`,
    [
      `marketplace.offer-matching-input.${input.action}.${input.offerId}.${sha256(input.audit.requestId)}.v1`,
      `marketplace.offer_matching_input.${input.action}`,
      input.audit.occurredAt,
      input.propertyId,
      input.audit.actorUserId,
      input.offerId,
      input.audit.correlationId ?? input.audit.requestId,
      input.audit.requestId,
      JSON.stringify({
        changedFields,
        matchingCriteriaOperation:
          input.request.matchingCriteria === undefined
            ? "unchanged"
            : input.request.matchingCriteria === null
              ? "deleted"
              : "upserted",
      }),
      JSON.stringify({
        actorOrganizationId: input.audit.actorOrganizationId,
        requestId: input.audit.requestId,
        source: input.audit.source,
      }),
    ],
  );
}

function offerMediaLateralSql(publicOnly: boolean): string {
  const visibilityFilter = publicOnly
    ? `AND media_object.visibility = 'public'
        AND media_object.public_approved = TRUE
        AND media_object.lifecycle_status = 'active'`
    : `AND media_object.lifecycle_status NOT IN (
          'quarantined', 'rejected', 'delete_requested', 'deleted'
        )`;
  return `
  LEFT JOIN LATERAL (
    SELECT
      jsonb_agg(
        jsonb_build_object(
          'mediaObjectId', item.id::text,
          'url', item.url,
          'approvalStatus', CASE
            WHEN item.public_approved THEN 'approved'
            ELSE 'pending_domain_approval'
          END,
          'lifecycleStatus', item.lifecycle_status
        ) ORDER BY item.created_at, item.id
      ) AS items,
      array_agg(item.url ORDER BY item.created_at, item.id)
        FILTER (WHERE item.url IS NOT NULL) AS urls
    FROM (
      SELECT
        media_object.id,
        media_object.created_at,
        media_object.public_approved,
        media_object.lifecycle_status,
        COALESCE(
          (
            SELECT variant.public_cdn_url
            FROM platform.media_variants variant
            WHERE variant.media_object_id = media_object.id
              AND variant.public_cdn_url IS NOT NULL
            ORDER BY CASE variant.variant_name
              WHEN 'original_safe' THEN 0
              WHEN 'large' THEN 1
              WHEN 'thumbnail' THEN 2
              ELSE 3
            END,
            variant.created_at,
            variant.id
            LIMIT 1
          ),
          media_object.source_url,
          CASE
            WHEN media_object.storage_key LIKE 'https://%' THEN media_object.storage_key
            ELSE NULL
          END
        ) AS url
      FROM platform.media_objects media_object
      WHERE media_object.owner_organization_id = offer.organization_id
        AND media_object.resource_product = 'marketplace'
        AND media_object.resource_type = 'marketplace_offer'
        AND media_object.resource_id = offer.id::text
        AND media_object.purpose = 'marketplace.offer.media'
        ${visibilityFilter}
    ) item
  ) offer_media ON TRUE
`;
}

const OFFER_MEDIA_LATERAL_SQL = offerMediaLateralSql(false);
const PUBLIC_OFFER_MEDIA_LATERAL_SQL = offerMediaLateralSql(true);

export async function syncOfferReadModel(
  client: Pick<MarketplaceAdminPool, "query">,
  offerId: string,
  visibilityMode: "initialize" | "disable",
  options: { catalogAlreadyProjected?: boolean } = {},
): Promise<void> {
  const source = await client.query<{ propertyId: string }>(
    `SELECT offer.property_id::text AS "propertyId"
     FROM marketplace.marketplace_offers offer
     WHERE offer.id = $1::uuid
     LIMIT 1`,
    [offerId],
  );
  const propertyId = source.rows[0]?.propertyId;
  if (!propertyId) return;

  if (!options.catalogAlreadyProjected) {
    if (!(await ensureCanonicalPropertySlug(client, propertyId))) return;
    await client.query(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE, [propertyId]);
  }
  await client.query(
    `INSERT INTO marketplace.marketplace_offer_read_model (
       offer_id,
       property_id,
       public_id,
       canonical_slug,
       display_name,
       offer_title,
       offer_summary,
       accommodation_type,
       visibility_status,
       location,
       image_urls,
       public_compensation_summary,
       public_creator_requirements,
       source_freshness,
       projected_at
     )
     SELECT
       offer.id,
       offer.property_id,
       COALESCE(offer.source_offer_id, offer.id::text),
       COALESCE(public_profile.canonical_slug, active_slug.slug, property.public_id),
       COALESCE(public_profile.display_name, property.display_name),
       offer.title,
       offer.offer_summary,
       offer.accommodation_type,
       CASE
         WHEN $2 = 'disable' THEN 'disabled'
         WHEN offer.offer_status = 'verified'
          AND marketplace_profile.marketplace_profile_status = 'verified'
          AND marketplace_profile.profile_complete = TRUE
          AND COALESCE(public_profile.profile_status, property.profile_status) = 'complete'
          AND COALESCE(cardinality(offer_media.urls), 0) > 0
          AND NULLIF(btrim(COALESCE(public_profile.display_name, property.display_name)), '')
            IS NOT NULL
          AND (
            NULLIF(public_profile.location->>'city', '') IS NOT NULL
            OR NULLIF(public_profile.location->>'countryCode', '') IS NOT NULL
            OR NULLIF(public_profile.location->>'region', '') IS NOT NULL
          )
           THEN 'public'
         ELSE 'private'
       END,
       jsonb_strip_nulls(jsonb_build_object(
         'countryCode', public_profile.location ->> 'countryCode',
         'region', public_profile.location ->> 'region',
         'city', public_profile.location ->> 'city'
       )),
       COALESCE(offer_media.urls, offer.image_urls, '{}'::text[]),
       COALESCE(compensation.items, '[]'::jsonb),
       COALESCE(requirements.item, '{}'::jsonb),
       jsonb_strip_nulls(jsonb_build_object(
         'source', 'marketplace_admin',
         'catalogProjectedAt', public_profile.projected_at
       )),
       now()
     FROM marketplace.marketplace_offers offer
     JOIN hotel_catalog.properties property ON property.id = offer.property_id
     JOIN marketplace.marketplace_hotel_profiles marketplace_profile
       ON marketplace_profile.property_id = offer.property_id
      AND marketplace_profile.organization_id = offer.organization_id
     LEFT JOIN hotel_catalog.property_public_profile_read_model public_profile
       ON public_profile.property_id = offer.property_id
     ${PUBLIC_OFFER_MEDIA_LATERAL_SQL}
     LEFT JOIN LATERAL (
       SELECT slug.slug
       FROM hotel_catalog.property_slugs slug
       WHERE slug.property_id = offer.property_id
         AND slug.status = 'active'
       ORDER BY CASE slug.purpose WHEN 'canonical' THEN 0 WHEN 'marketplace_overlay' THEN 1 ELSE 2 END,
                slug.created_at,
                slug.id
       LIMIT 1
     ) active_slug ON TRUE
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
         jsonb_strip_nulls(jsonb_build_object(
           'type', option.compensation_type,
           'months', option.availability_months,
           'platforms', option.platforms,
           'freeStayMinNights', option.free_stay_min_nights,
           'freeStayMaxNights', option.free_stay_max_nights,
           'paidMaxAmount', option.paid_max_amount,
           'discountPercentage', option.discount_percentage,
           'commissionPercentage', option.commission_percentage,
           'minFollowers', option.min_followers,
           'currency', option.currency,
           'termsSummary', option.terms_summary
         )) ORDER BY option.created_at, option.id
       ) AS items
       FROM marketplace.offer_compensation_options option
       WHERE option.offer_id = offer.id
         AND option.property_id = offer.property_id
         AND option.organization_id = offer.organization_id
     ) compensation ON TRUE
     LEFT JOIN LATERAL (
       SELECT jsonb_build_object(
         'platforms', requirement.platforms,
         'countries', requirement.target_countries,
         'ageGroups', requirement.target_age_groups,
         'creatorTypes', requirement.creator_types
       ) AS item
       FROM marketplace.offer_creator_requirements requirement
       WHERE requirement.offer_id = offer.id
         AND requirement.property_id = offer.property_id
         AND requirement.organization_id = offer.organization_id
     ) requirements ON TRUE
     WHERE offer.id = $1::uuid
     ON CONFLICT (offer_id) DO UPDATE
     SET property_id = EXCLUDED.property_id,
         public_id = EXCLUDED.public_id,
         canonical_slug = EXCLUDED.canonical_slug,
         display_name = EXCLUDED.display_name,
         offer_title = EXCLUDED.offer_title,
         offer_summary = EXCLUDED.offer_summary,
         accommodation_type = EXCLUDED.accommodation_type,
         visibility_status = EXCLUDED.visibility_status,
         location = EXCLUDED.location,
         image_urls = EXCLUDED.image_urls,
         public_compensation_summary = EXCLUDED.public_compensation_summary,
         public_creator_requirements = EXCLUDED.public_creator_requirements,
         source_freshness = EXCLUDED.source_freshness,
         projected_at = EXCLUDED.projected_at`,
    [offerId, visibilityMode],
  );
}

export async function syncPropertyOfferReadModels(
  client: Pick<MarketplaceAdminPool, "query">,
  input: { propertyId: string },
): Promise<void> {
  if (!(await ensureCanonicalPropertySlug(client, input.propertyId))) return;
  await client.query(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE, [input.propertyId]);

  const offers = await client.query<{ offerId: string }>(
    `SELECT offer.id::text AS "offerId"
     FROM marketplace.marketplace_offers offer
     WHERE offer.property_id = $1::uuid
       AND offer.offer_status <> 'archived'
     ORDER BY offer.id`,
    [input.propertyId],
  );
  for (const { offerId } of offers.rows) {
    await syncOfferReadModel(client, offerId, "initialize", {
      catalogAlreadyProjected: true,
    });
  }
}

export async function readOffer(
  client: Pick<MarketplaceAdminPool, "query">,
  offerResourceId: string,
  authorizationMode: MarketplaceAdminAuthorizationMode,
): Promise<MarketplaceAdminOffer | null> {
  const result = await client.query<OfferRow>(
    `${OFFER_SELECT_SQL}
     WHERE offer.id::text = $1
     LIMIT 1`,
    [offerResourceId],
  );
  const row = result.rows[0];
  return row ? mapOfferRow(row, authorizationMode) : null;
}

export function mapOfferRow(
  row: OfferRow,
  authorizationMode: MarketplaceAdminAuthorizationMode,
): MarketplaceAdminOffer {
  return {
    contractVersion: MARKETPLACE_ADMIN_CONTRACT_VERSION,
    authorizationMode,
    offerId: row.offerId,
    propertyId: row.propertyId,
    offerStatus: row.offerStatus,
    title: row.title,
    offerSummary: row.offerSummary,
    media: toOfferMedia(row.media),
    deliverables: toOfferDeliverables(row.deliverables),
    compensationOptions: toCompensationOptions(row.compensationOptions),
    creatorRequirements: toCreatorRequirements(row.creatorRequirements),
    matchingCriteria: toMatchingCriteria(row.matchingCriteria),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function toOfferMedia(value: unknown): MarketplaceAdminOfferMedia[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const url = readString(item.url);
    const mediaObjectId = readString(item.mediaObjectId);
    if (!mediaObjectId && !url) return [];
    return [
      {
        mediaObjectId,
        url,
        approvalStatus:
          item.approvalStatus === "pending_domain_approval"
            ? "pending_domain_approval"
            : "approved",
        lifecycleStatus: item.lifecycleStatus === "staged" ? "staged" : "active",
      },
    ];
  });
}

function toInviteCode(row: InviteCodeRow): MarketplaceAdminInviteCode {
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

function toCompensationOptions(value: unknown): MarketplaceAdminOffer["compensationOptions"] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((row) => ({
    compensationOptionId: readString(row.compensationOptionId) ?? "",
    compensationType: toOfferCompensationType(row.compensationType) ?? "free_stay",
    availabilityMonths: toStringArray(row.availabilityMonths),
    platforms: toPlatformArray(row.platforms),
    freeStayMinNights: toNullableNumber(row.freeStayMinNights),
    freeStayMaxNights: toNullableNumber(row.freeStayMaxNights),
    paidMaxAmount: toNullableDecimal(row.paidMaxAmount),
    discountPercentage: toNullableNumber(row.discountPercentage),
    commissionPercentage: toNullableNumber(row.commissionPercentage),
    minFollowers: toNullableNumber(row.minFollowers),
    followerRequirementLevel: toRequirementLevel(row.followerRequirementLevel),
    currency: readString(row.currency),
    termsSummary: readString(row.termsSummary),
  }));
}

function toOfferDeliverables(value: unknown): MarketplaceAdminOffer["deliverables"] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((row) => ({
    deliverableId: readString(row.deliverableId) ?? "",
    platform: toPlatformName(row.platform) ?? "other",
    deliverableType: readString(row.deliverableType) ?? "post",
    quantity: toNullableNumber(row.quantity) ?? 1,
    timingGuidance: readString(row.timingGuidance),
    requirementLevel: toRequirementLevel(row.requirementLevel),
  }));
}

function toCreatorRequirements(value: unknown): MarketplaceOfferCreatorRequirementsWrite | null {
  if (!isRecord(value) || Object.keys(value).length === 0) return null;
  return {
    platforms: toPlatformArray(value.platforms),
    platformRequirementLevel: toRequirementLevel(value.platformRequirementLevel),
    targetCountries: toStringArray(value.targetCountries),
    targetCountriesRequirementLevel: toRequirementLevel(value.targetCountriesRequirementLevel),
    targetAgeMin: toNullableNumber(value.targetAgeMin),
    targetAgeMax: toNullableNumber(value.targetAgeMax),
    targetAgeGroups: toStringArray(value.targetAgeGroups),
    creatorTypes: toStringArray(value.creatorTypes)
      .map((type) => (type === "lifestyle" || type === "travel" ? type : "other"))
      .filter((type, index, items) => items.indexOf(type) === index),
    creatorTypesRequirementLevel: toRequirementLevel(value.creatorTypesRequirementLevel),
  };
}

function toMatchingCriteria(value: unknown): MarketplaceOfferMatchingCriteria | null {
  if (value === null || value === undefined) return null;
  const criteria = parseMarketplaceOfferMatchingCriteria(value);
  if (!criteria) throw new Error("Stored Marketplace offer matching criteria is invalid");
  return criteria;
}

function toRequirementLevel(value: unknown): MarketplaceOfferRequirementLevel | null {
  return value === "required" || value === "preferred" ? value : null;
}

function toOfferCompensationType(
  value: unknown,
): MarketplaceOfferCompensationOptionWrite["compensationType"] | null {
  switch (value) {
    case "free_stay":
    case "paid":
    case "discount":
    case "affiliate":
      return value;
    default:
      return null;
  }
}

function toPlatformArray(value: unknown): MarketplacePlatformName[] {
  return toStringArray(value).map((platform) => {
    switch (platform) {
      case "instagram":
      case "tiktok":
      case "youtube":
      case "facebook":
      case "blog":
      case "x":
        return platform;
      default:
        return "other";
    }
  });
}

function toPlatformName(value: unknown): MarketplacePlatformName | null {
  return typeof value === "string" && toPlatformArray([value])[0] === value ? value : null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPositiveDecimalString(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function isPercentage(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function toNullableDecimal(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry)).filter((entry) => entry.length > 0)
    : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

export type OfferRow = {
  offerId: string;
  propertyId: string;
  offerStatus: MarketplaceAdminOffer["offerStatus"];
  title: string;
  offerSummary: string | null;
  media: unknown;
  deliverables: unknown;
  compensationOptions: unknown;
  creatorRequirements: unknown;
  matchingCriteria?: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
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
    FROM marketplace.invite_codes invite
  )
  ${INVITE_CODE_SELECT_BODY}
`;

export const OFFER_SELECT_SQL = `
  SELECT
    offer.id::text AS "offerId",
    offer.property_id::text AS "propertyId",
    offer.offer_status AS "offerStatus",
    offer.title,
    offer.offer_summary AS "offerSummary",
    COALESCE(offer_media.items, legacy_media.items, '[]'::jsonb) AS media,
    COALESCE(deliverables.items, '[]'::jsonb) AS deliverables,
    COALESCE(compensation.items, '[]'::jsonb) AS "compensationOptions",
    COALESCE(requirements.item, '{}'::jsonb) AS "creatorRequirements",
    matching_criteria.item AS "matchingCriteria",
    offer.created_at AS "createdAt",
    offer.updated_at AS "updatedAt"
  FROM marketplace.marketplace_offers offer
  ${OFFER_MEDIA_LATERAL_SQL}
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object('mediaObjectId', NULL, 'url', legacy.url)
      ORDER BY legacy.ordinality
    ) AS items
    FROM unnest(offer.image_urls) WITH ORDINALITY AS legacy(url, ordinality)
    WHERE NULLIF(btrim(legacy.url), '') IS NOT NULL
  ) legacy_media ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'deliverableId', deliverable.id::text,
        'platform', deliverable.platform,
        'deliverableType', deliverable.deliverable_type,
        'quantity', deliverable.quantity,
        'timingGuidance', deliverable.timing_guidance,
        'requirementLevel', deliverable.requirement_level
      ) ORDER BY deliverable.created_at, deliverable.id
    ) AS items
    FROM marketplace.offer_deliverables deliverable
    WHERE deliverable.offer_id = offer.id
      AND deliverable.property_id = offer.property_id
      AND deliverable.organization_id = offer.organization_id
  ) deliverables ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'compensationOptionId', option.id::text,
        'compensationType', option.compensation_type,
        'availabilityMonths', option.availability_months,
        'platforms', option.platforms,
        'freeStayMinNights', option.free_stay_min_nights,
        'freeStayMaxNights', option.free_stay_max_nights,
        'paidMaxAmount', option.paid_max_amount,
        'discountPercentage', option.discount_percentage,
        'commissionPercentage', option.commission_percentage,
        'minFollowers', option.min_followers,
        'currency', option.currency,
        'termsSummary', option.terms_summary,
        'followerRequirementLevel', option.follower_requirement_level
      )
      ORDER BY option.created_at ASC, option.id ASC
    ) AS items
    FROM marketplace.offer_compensation_options option
    WHERE option.offer_id = offer.id
      AND option.property_id = offer.property_id
      AND option.organization_id = offer.organization_id
  ) compensation ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'platforms', requirement.platforms,
      'platformRequirementLevel', requirement.platform_requirement_level,
      'targetCountries', COALESCE(requirement.target_countries, '{}'),
      'targetCountriesRequirementLevel', requirement.target_countries_requirement_level,
      'targetAgeMin', requirement.target_age_min,
      'targetAgeMax', requirement.target_age_max,
      'targetAgeGroups', requirement.target_age_groups,
      'creatorTypes', requirement.creator_types,
      'creatorTypesRequirementLevel', requirement.creator_types_requirement_level
    ) AS item
    FROM marketplace.offer_creator_requirements requirement
    WHERE requirement.offer_id = offer.id
      AND requirement.property_id = offer.property_id
      AND requirement.organization_id = offer.organization_id
    LIMIT 1
  ) requirements ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'contractVersion', criteria.contract_version,
      'revision', criteria.revision,
      'updatedAt', criteria.updated_at
    ) || criteria.criteria AS item
    FROM marketplace.offer_matching_criteria criteria
    WHERE criteria.offer_id = offer.id
      AND criteria.property_id = offer.property_id
      AND criteria.organization_id = offer.organization_id
    LIMIT 1
  ) matching_criteria ON TRUE
`;
