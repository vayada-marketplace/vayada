import { createHash } from "node:crypto";

import { requireAuthContext, type PermissionKey, type RequestContext } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg, { type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import { enforceRoutePolicy } from "./policy.js";

export const MARKETPLACE_ADMIN_CONTRACT_VERSION = "marketplace-admin.v1" as const;

export const MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT = {
  method: "GET",
  path: "/api/marketplace/admin/collaborations",
  owner: "marketplace",
  permission: "platform.user.suspend" satisfies PermissionKey,
  fallback: "opt-in legacy users.is_superadmin during platform organization migration",
  doc: "engineering/marketplace-admin-contract.md",
} as const;

export const MARKETPLACE_ADMIN_HOTEL_LISTINGS_CONTRACT = {
  methods: ["POST", "PUT", "DELETE"],
  path: "/api/marketplace/admin/users/:hotelUserId/listings[/:listingId]",
  owner: "marketplace",
  permission: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.permission,
  fallback: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.fallback,
  doc: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.doc,
} as const;

export type MarketplaceAdminAuthorizationMode =
  | "platform_organization_membership"
  | "legacy_superadmin_fallback";

export type MarketplaceAdminRouteAccess = {
  context: RequestContext;
  authorizationMode: MarketplaceAdminAuthorizationMode;
};

export type MarketplaceCollaborationStatus =
  | "pending"
  | "negotiating"
  | "accepted"
  | "active"
  | "completed"
  | "cancelled"
  | "rejected"
  | "declined";

export type MarketplaceCollaborationSide = "creator" | "hotel";

export type MarketplaceCollaborationRead = {
  contractVersion: "marketplace-collaboration-reads.v1";
  authorizationMode: "hotel_group_resource_link" | "creator_workspace_resource_link";
  collaborationId: string;
  listingId: string;
  creatorId: string;
  hotelProfileId: string;
  side: MarketplaceCollaborationSide;
  initiatorSide: MarketplaceCollaborationSide;
  isInitiator: boolean;
  status: MarketplaceCollaborationStatus;
  collaborationType: "free_stay" | "paid" | "discount" | "affiliate" | null;
  listingName: string;
  listingLocation: string | null;
  creator: MarketplaceCollaborationParticipant;
  hotel: MarketplaceCollaborationParticipant;
  terms: {
    freeStayMinNights: number | null;
    freeStayMaxNights: number | null;
    paidAmount: string | null;
    currency: string | null;
    discountPercentage: number | null;
    creatorFee: string | null;
    travelDateFrom: string | null;
    travelDateTo: string | null;
    preferredDateFrom: string | null;
    preferredDateTo: string | null;
    preferredMonths: string[];
  };
  deliverables: MarketplaceCollaborationDeliverable[];
  lastMessageAt: string | null;
  applicationMessage: string | null;
  hotelAgreedAt: string | null;
  creatorAgreedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceCollaborationParticipant = {
  side: MarketplaceCollaborationSide;
  organizationId: string;
  profileId: string;
  displayName: string;
  avatarUrl: string | null;
};

export type MarketplaceCollaborationDeliverable = {
  deliverableId: string;
  platform: string;
  type: string;
  quantity: number;
  status: "pending" | "completed";
  completedAt: string | null;
};

export type MarketplaceAdminCollaborationsResponse = {
  contractVersion: typeof MARKETPLACE_ADMIN_CONTRACT_VERSION;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  collaborations: MarketplaceCollaborationRead[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
};

export type MarketplaceCollaborationLifecycleWriteResponse = {
  contractVersion: "marketplace-collaboration-lifecycle-writes.v1";
  command: {
    action: "respond" | "approve_terms";
    idempotencyKey: string;
    acceptedAt?: string;
  };
  collaboration: MarketplaceCollaborationRead;
  sideEffects: { type: string; idempotencyKey?: string }[];
};

export type MarketplacePlatformName =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "facebook"
  | "blog"
  | "x"
  | "other";

export type MarketplaceHotelListingOfferingWrite = {
  collaborationType: "free_stay" | "paid" | "discount" | "affiliate";
  availabilityMonths: string[];
  platforms: MarketplacePlatformName[];
  freeStayMinNights: number | null;
  freeStayMaxNights: number | null;
  paidMaxAmount: string | null;
  discountPercentage: number | null;
  commissionPercentage: number | null;
  minFollowers: number | null;
  currency: string | null;
  termsSummary: string | null;
};

export type MarketplaceHotelListingCreatorRequirementsWrite = {
  platforms: MarketplacePlatformName[];
  targetCountries: string[];
  targetAgeMin: number | null;
  targetAgeMax: number | null;
  targetAgeGroups: string[];
  creatorTypes: ("lifestyle" | "travel" | "other")[];
};

export type MarketplaceAdminCreateHotelListingRequest = {
  title: string;
  listingSummary?: string | null;
  accommodationType?:
    | "hotel"
    | "resort"
    | "boutique_hotel"
    | "lodge"
    | "apartment"
    | "villa"
    | "other"
    | null;
  rawLocationText?: string | null;
  imageUrls?: string[];
  collaborationOfferings: MarketplaceHotelListingOfferingWrite[];
  creatorRequirements: MarketplaceHotelListingCreatorRequirementsWrite;
};

export type MarketplaceAdminUpdateHotelListingRequest = Partial<
  Omit<MarketplaceAdminCreateHotelListingRequest, "collaborationOfferings" | "creatorRequirements">
> & {
  collaborationOfferings?: MarketplaceHotelListingOfferingWrite[];
  creatorRequirements?: MarketplaceHotelListingCreatorRequirementsWrite | null;
};

export type MarketplaceAdminHotelListing = {
  contractVersion: typeof MARKETPLACE_ADMIN_CONTRACT_VERSION;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  listingId: string;
  propertyId: string;
  listingStatus: "draft" | "pending" | "verified" | "rejected" | "suspended" | "archived";
  title: string;
  listingSummary: string | null;
  accommodationType: MarketplaceAdminCreateHotelListingRequest["accommodationType"];
  rawLocationText: string | null;
  imageUrls: string[];
  collaborationOfferings: (MarketplaceHotelListingOfferingWrite & { offeringId: string })[];
  creatorRequirements: MarketplaceHotelListingCreatorRequirementsWrite | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceAdminDeleteHotelListingResponse = {
  contractVersion: typeof MARKETPLACE_ADMIN_CONTRACT_VERSION;
  authorizationMode: MarketplaceAdminAuthorizationMode;
  deletedListing: {
    listingId: string;
    title: string;
  };
};

export type MarketplaceAdminRepository = {
  listCollaborations(input: {
    page: number;
    pageSize: number;
    status?: MarketplaceCollaborationStatus;
    search?: string;
  }): Promise<{ collaborations: MarketplaceCollaborationRead[]; total: number }>;
  respondToCollaborationAsHotel(input: {
    collaborationId: string;
    status: "accepted" | "declined";
    responseMessage?: string;
    idempotencyKey: string;
  }): Promise<MarketplaceCollaborationLifecycleWriteResponse | null>;
  approveCollaborationAsHotel(input: {
    collaborationId: string;
    idempotencyKey: string;
  }): Promise<MarketplaceCollaborationLifecycleWriteResponse | null>;
  createHotelListingForUser(input: {
    hotelUserId: string;
    request: MarketplaceAdminCreateHotelListingRequest;
    authorizationMode: MarketplaceAdminAuthorizationMode;
  }): Promise<MarketplaceAdminHotelListing | null>;
  updateHotelListingForUser(input: {
    hotelUserId: string;
    listingId: string;
    request: MarketplaceAdminUpdateHotelListingRequest;
    authorizationMode: MarketplaceAdminAuthorizationMode;
  }): Promise<MarketplaceAdminHotelListing | null>;
  deleteHotelListingForUser(input: {
    hotelUserId: string;
    listingId: string;
    authorizationMode: MarketplaceAdminAuthorizationMode;
  }): Promise<MarketplaceAdminDeleteHotelListingResponse | null>;
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
    async listCollaborations(input) {
      const params: unknown[] = [];
      const filters = buildCollaborationFilters(input, params);
      const limitParam = params.length + 1;
      const offsetParam = params.length + 2;
      const queryParams = [...params, input.pageSize, (input.page - 1) * input.pageSize];
      const [rows, count] = await Promise.all([
        pool.query<CollaborationRow>(
          `${COLLABORATION_SELECT_SQL}
           ${filters}
           ORDER BY collaboration.created_at DESC, collaboration.id ASC
           LIMIT $${limitParam} OFFSET $${offsetParam}`,
          queryParams,
        ),
        pool.query<{ total: string }>(
          `SELECT count(*)::text AS total
           FROM (${COLLABORATION_SELECT_SQL} ${filters}) AS admin_collaborations`,
          params,
        ),
      ]);
      return {
        collaborations: rows.rows.map(mapCollaborationRow),
        total: Number(count.rows[0]?.total ?? 0),
      };
    },
    async respondToCollaborationAsHotel(input) {
      const nextStatus = input.status === "accepted" ? "negotiating" : "declined";
      return executeMarketplaceAdminLifecycleCommand(pool, {
        operation: "marketplace_admin_collaboration_respond",
        collaborationId: input.collaborationId,
        idempotencyKey: input.idempotencyKey,
        fingerprintPayload: {
          action: "respond",
          collaborationId: input.collaborationId,
          status: input.status,
          responseMessage: input.responseMessage ?? "",
        },
        command: {
          action: "respond",
          idempotencyKey: input.idempotencyKey,
        },
        async mutate(client) {
          const result = await client.query<CollaborationRow>(
            `${COLLABORATION_MUTATION_CTE}
             UPDATE marketplace.collaborations AS collaboration
             SET lifecycle_status = $2,
                 responded_at = now(),
                 collaboration_metadata = jsonb_set(
                   collaboration.collaboration_metadata,
                   '{adminResponseMessage}',
                   to_jsonb($3::text),
                   true
                 ),
                 updated_at = now()
             FROM matched
             WHERE collaboration.id = matched.id
             RETURNING collaboration.id`,
            [input.collaborationId, nextStatus, input.responseMessage ?? ""],
          );
          return result.rows[0]?.id ?? null;
        },
      });
    },
    async approveCollaborationAsHotel(input) {
      const acceptedAt = new Date().toISOString();
      return executeMarketplaceAdminLifecycleCommand(pool, {
        operation: "marketplace_admin_collaboration_approve_terms",
        collaborationId: input.collaborationId,
        idempotencyKey: input.idempotencyKey,
        fingerprintPayload: {
          action: "approve_terms",
          collaborationId: input.collaborationId,
        },
        command: {
          action: "approve_terms",
          idempotencyKey: input.idempotencyKey,
          acceptedAt,
        },
        async mutate(client) {
          const result = await client.query<CollaborationRow>(
            `${COLLABORATION_MUTATION_CTE}
             UPDATE marketplace.collaborations AS collaboration
             SET hotel_agreed_at = COALESCE(collaboration.hotel_agreed_at, now()),
                 lifecycle_status = CASE
                   WHEN collaboration.creator_agreed_at IS NOT NULL THEN 'accepted'
                   ELSE 'negotiating'
                 END,
                 updated_at = now()
             FROM matched
             WHERE collaboration.id = matched.id
             RETURNING collaboration.id`,
            [input.collaborationId],
          );
          return result.rows[0]?.id ?? null;
        },
      });
    },
    async createHotelListingForUser(input) {
      return writeListing(pool, async (client) => {
        const profile = await resolveAdminHotelProfile(client, input.hotelUserId);
        if (!profile) return null;
        const listing = await client.query<{ id: string }>(
          `INSERT INTO marketplace.marketplace_hotel_listings (
             property_id,
             organization_id,
             source_system,
             source_listing_id,
             title,
             listing_summary,
             accommodation_type,
             listing_status,
             raw_location_text,
             image_urls
           )
           VALUES ($1, $2, 'marketplace', gen_random_uuid()::text, $3, $4, $5, 'verified', $6, $7)
           RETURNING id`,
          [
            profile.propertyId,
            profile.organizationId,
            input.request.title,
            input.request.listingSummary ?? null,
            input.request.accommodationType ?? null,
            input.request.rawLocationText ?? null,
            input.request.imageUrls ?? [],
          ],
        );
        const listingId = listing.rows[0]?.id;
        if (!listingId) return null;
        await replaceListingChildren(client, {
          listingId,
          propertyId: profile.propertyId,
          organizationId: profile.organizationId,
          offerings: input.request.collaborationOfferings,
          creatorRequirements: input.request.creatorRequirements,
        });
        return readListing(client, listingId, input.authorizationMode);
      });
    },
    async updateHotelListingForUser(input) {
      return writeListing(pool, async (client) => {
        const profile = await resolveAdminHotelProfile(client, input.hotelUserId);
        if (!profile) return null;
        const target = await resolveListingForProfile(client, profile, input.listingId);
        if (!target) return null;
        await client.query(
          `UPDATE marketplace.marketplace_hotel_listings
           SET title = COALESCE($2, title),
               listing_summary = CASE WHEN $3::boolean THEN $4 ELSE listing_summary END,
               accommodation_type = CASE WHEN $5::boolean THEN $6 ELSE accommodation_type END,
               raw_location_text = CASE WHEN $7::boolean THEN $8 ELSE raw_location_text END,
               image_urls = CASE WHEN $9::boolean THEN $10::text[] ELSE image_urls END,
               updated_at = now()
           WHERE id = $1`,
          [
            target.listingResourceId,
            input.request.title,
            input.request.listingSummary !== undefined,
            input.request.listingSummary ?? null,
            input.request.accommodationType !== undefined,
            input.request.accommodationType ?? null,
            input.request.rawLocationText !== undefined,
            input.request.rawLocationText ?? null,
            input.request.imageUrls !== undefined,
            input.request.imageUrls ?? [],
          ],
        );
        if (
          input.request.collaborationOfferings !== undefined ||
          input.request.creatorRequirements !== undefined
        ) {
          await replaceListingChildren(client, {
            listingId: target.listingResourceId,
            propertyId: profile.propertyId,
            organizationId: profile.organizationId,
            offerings: input.request.collaborationOfferings,
            creatorRequirements: input.request.creatorRequirements,
          });
        }
        return readListing(client, target.listingResourceId, input.authorizationMode);
      });
    },
    async deleteHotelListingForUser(input) {
      return writeListing(pool, async (client) => {
        const profile = await resolveAdminHotelProfile(client, input.hotelUserId);
        if (!profile) return null;
        const target = await resolveListingForProfile(client, profile, input.listingId);
        if (!target) return null;
        await client.query(
          `UPDATE marketplace.marketplace_hotel_listings
           SET listing_status = 'archived', updated_at = now()
           WHERE id = $1`,
          [target.listingResourceId],
        );
        return {
          contractVersion: MARKETPLACE_ADMIN_CONTRACT_VERSION,
          authorizationMode: input.authorizationMode,
          deletedListing: {
            listingId: target.sourceListingId,
            title: target.title,
          },
        };
      });
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

  app.get<{ Querystring: AdminCollaborationsQuery }>("/admin/collaborations", async (request) => {
    const access = await requireMarketplaceAdminAccess(request, options);
    const page = parsePositiveInteger(firstQueryValue(request.query.page), 1);
    const pageSize = Math.min(
      parsePositiveInteger(
        firstQueryValue(request.query.pageSize) ?? firstQueryValue(request.query.page_size),
        20,
      ),
      100,
    );
    const status = toCollaborationStatus(firstQueryValue(request.query.status));
    const search = firstQueryValue(request.query.search);
    const result = await repository.listCollaborations({
      page,
      pageSize,
      ...(status ? { status } : {}),
      ...(search ? { search } : {}),
    });
    return {
      contractVersion: MARKETPLACE_ADMIN_CONTRACT_VERSION,
      authorizationMode: access.authorizationMode,
      collaborations: result.collaborations,
      pagination: {
        page,
        pageSize,
        total: result.total,
      },
    } satisfies MarketplaceAdminCollaborationsResponse;
  });

  app.post<{ Params: CollaborationParams; Body: RespondBody }>(
    "/admin/collaborations/:collaborationId/respond",
    async (request, reply) => {
      await requireMarketplaceAdminAccess(request, options);
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return sendAdminError(reply, 422, "idempotency_required");
      if (request.body?.status !== "accepted" && request.body?.status !== "declined") {
        return sendAdminError(reply, 422, "invalid_status");
      }
      const result = await repository.respondToCollaborationAsHotel({
        collaborationId: request.params.collaborationId,
        status: request.body.status,
        responseMessage: request.body.responseMessage ?? request.body.response_message,
        idempotencyKey,
      });
      if (!result) return sendAdminError(reply, 404, "collaboration_not_found");
      return result;
    },
  );

  app.post<{ Params: CollaborationParams; Body: ApproveBody }>(
    "/admin/collaborations/:collaborationId/approve",
    async (request, reply) => {
      await requireMarketplaceAdminAccess(request, options);
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return sendAdminError(reply, 422, "idempotency_required");
      const result = await repository.approveCollaborationAsHotel({
        collaborationId: request.params.collaborationId,
        idempotencyKey,
      });
      if (!result) return sendAdminError(reply, 404, "collaboration_not_found");
      return result;
    },
  );

  app.post<{ Params: HotelUserParams; Body: MarketplaceAdminCreateHotelListingRequest }>(
    "/admin/users/:hotelUserId/listings",
    async (request, reply) => {
      const access = await requireMarketplaceAdminAccess(request, options);
      const validation = validateCreateListingRequest(request.body);
      if (validation) return sendAdminError(reply, 422, validation);
      const result = await repository.createHotelListingForUser({
        hotelUserId: request.params.hotelUserId,
        request: request.body,
        authorizationMode: access.authorizationMode,
      });
      if (!result) return sendAdminError(reply, 404, "hotel_profile_not_found");
      return reply.status(201).send(result);
    },
  );

  app.put<{ Params: ListingParams; Body: MarketplaceAdminUpdateHotelListingRequest }>(
    "/admin/users/:hotelUserId/listings/:listingId",
    async (request, reply) => {
      const access = await requireMarketplaceAdminAccess(request, options);
      const validation = validateUpdateListingRequest(request.body);
      if (validation) return sendAdminError(reply, 422, validation);
      const result = await repository.updateHotelListingForUser({
        hotelUserId: request.params.hotelUserId,
        listingId: request.params.listingId,
        request: request.body,
        authorizationMode: access.authorizationMode,
      });
      if (!result) return sendAdminError(reply, 404, "listing_not_found");
      return result;
    },
  );

  app.delete<{ Params: ListingParams }>(
    "/admin/users/:hotelUserId/listings/:listingId",
    async (request, reply) => {
      const access = await requireMarketplaceAdminAccess(request, options);
      const result = await repository.deleteHotelListingForUser({
        hotelUserId: request.params.hotelUserId,
        listingId: request.params.listingId,
        authorizationMode: access.authorizationMode,
      });
      if (!result) return sendAdminError(reply, 404, "listing_not_found");
      return result;
    },
  );
}

async function requireMarketplaceAdminAccess(
  request: FastifyRequest,
  options: MarketplaceAdminRoutesOptions,
): Promise<MarketplaceAdminRouteAccess> {
  try {
    const context = enforceRoutePolicy(request, {
      permission: MARKETPLACE_ADMIN_COLLABORATIONS_CONTRACT.permission,
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

function readIdempotencyKey(request: FastifyRequest): string | null {
  const header = request.headers["idempotency-key"];
  const headerValue = Array.isArray(header) ? header[0] : header;
  const body = request.body && typeof request.body === "object" ? request.body : {};
  const bodyValue = "idempotencyKey" in body ? body.idempotencyKey : undefined;
  return readNonEmptyString(headerValue) ?? readNonEmptyString(bodyValue);
}

function validateCreateListingRequest(
  body: MarketplaceAdminCreateHotelListingRequest | undefined,
): string | null {
  if (!body || !readNonEmptyString(body.title)) return "title_required";
  if (!Array.isArray(body.collaborationOfferings) || body.collaborationOfferings.length === 0) {
    return "collaboration_offerings_required";
  }
  if (!body.creatorRequirements) return "creator_requirements_required";
  return validateListingChildren(body.collaborationOfferings, body.creatorRequirements);
}

function validateUpdateListingRequest(
  body: MarketplaceAdminUpdateHotelListingRequest | undefined,
): string | null {
  if (!body) return "body_required";
  if (body.title !== undefined && !readNonEmptyString(body.title)) return "title_required";
  if (body.collaborationOfferings?.length === 0) return "collaboration_offerings_required";
  return validateListingChildren(body.collaborationOfferings, body.creatorRequirements);
}

function validateListingChildren(
  offerings?: MarketplaceHotelListingOfferingWrite[],
  requirements?: MarketplaceHotelListingCreatorRequirementsWrite | null,
): string | null {
  if (offerings) {
    for (const offering of offerings) {
      if (!["free_stay", "paid", "discount", "affiliate"].includes(offering.collaborationType)) {
        return "invalid_collaboration_type";
      }
      if (offering.collaborationType === "free_stay") {
        if (
          !isPositiveInteger(offering.freeStayMinNights) ||
          !isPositiveInteger(offering.freeStayMaxNights) ||
          offering.freeStayMinNights > offering.freeStayMaxNights
        ) {
          return "invalid_free_stay";
        }
      }
      if (
        offering.collaborationType === "paid" &&
        !isPositiveDecimalString(offering.paidMaxAmount)
      ) {
        return "invalid_paid_amount";
      }
      if (offering.collaborationType === "discount" && !isPercentage(offering.discountPercentage)) {
        return "invalid_discount";
      }
      if (
        offering.collaborationType === "affiliate" &&
        !isPercentage(offering.commissionPercentage)
      ) {
        return "invalid_commission";
      }
    }
  }
  if (requirements && !Array.isArray(requirements.platforms)) return "invalid_requirements";
  return null;
}

function sendAdminError(reply: FastifyReply, statusCode: 404 | 422, code: string) {
  return reply.status(statusCode).send({
    statusCode,
    code,
    category: statusCode === 404 ? "not_found" : "validation",
    message: code,
  });
}

async function writeListing<T>(
  pool: MarketplaceAdminPool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type MarketplaceAdminLifecycleOperation =
  | "marketplace_admin_collaboration_respond"
  | "marketplace_admin_collaboration_approve_terms";

type MarketplaceAdminLifecycleReplayRow = {
  status: "in_progress" | "completed" | "failed" | "expired" | "conflict";
  requestFingerprintHash: string;
  metadata: unknown;
};

async function executeMarketplaceAdminLifecycleCommand(
  pool: MarketplaceAdminPool,
  input: {
    operation: MarketplaceAdminLifecycleOperation;
    collaborationId: string;
    idempotencyKey: string;
    fingerprintPayload: unknown;
    command: MarketplaceCollaborationLifecycleWriteResponse["command"];
    mutate(client: PoolClient): Promise<string | null>;
  },
): Promise<MarketplaceCollaborationLifecycleWriteResponse | null> {
  const keyHash = sha256(
    stableJson({ collaborationId: input.collaborationId, key: input.idempotencyKey }),
  );
  const fingerprint = sha256(stableJson(input.fingerprintPayload));
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const existing = await findMarketplaceAdminLifecycleReplay(client, {
      operation: input.operation,
      keyHash,
    });
    const replay = readMarketplaceAdminLifecycleReplay(existing, fingerprint);
    if (replay) {
      await client.query("COMMIT");
      transactionOpen = false;
      return replay;
    }

    const reserved = await reserveMarketplaceAdminLifecycleIdempotency(client, {
      operation: input.operation,
      collaborationId: input.collaborationId,
      idempotencyKey: input.idempotencyKey,
      keyHash,
      fingerprint,
    });
    if (!reserved) {
      const current = await findMarketplaceAdminLifecycleReplay(client, {
        operation: input.operation,
        keyHash,
      });
      const currentReplay = readMarketplaceAdminLifecycleReplay(current, fingerprint);
      if (currentReplay) {
        await client.query("COMMIT");
        transactionOpen = false;
        return currentReplay;
      }
      throw new Error("Marketplace admin lifecycle idempotency key is already in progress.");
    }

    const collaborationResourceId = await input.mutate(client);
    if (!collaborationResourceId) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return null;
    }

    const response = await readLifecycleWrite(client, collaborationResourceId, input.command);
    await completeMarketplaceAdminLifecycleIdempotency(client, {
      operation: input.operation,
      keyHash,
      fingerprint,
      response,
    });
    await client.query("COMMIT");
    transactionOpen = false;
    return response;
  } catch (error) {
    if (transactionOpen) await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function findMarketplaceAdminLifecycleReplay(
  client: Pick<MarketplaceAdminPool, "query">,
  input: { operation: MarketplaceAdminLifecycleOperation; keyHash: string },
): Promise<MarketplaceAdminLifecycleReplayRow | null> {
  const result = await client.query<MarketplaceAdminLifecycleReplayRow>(
    `SELECT
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       idempotency_metadata AS metadata
     FROM platform.idempotency_keys
     WHERE operation_scope = 'marketplace'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'platform'
     LIMIT 1
     FOR UPDATE`,
    [input.operation, input.keyHash],
  );
  return result.rows[0] ?? null;
}

function readMarketplaceAdminLifecycleReplay(
  row: MarketplaceAdminLifecycleReplayRow | null,
  fingerprint: string,
): MarketplaceCollaborationLifecycleWriteResponse | null {
  if (!row) return null;
  if (row.requestFingerprintHash !== fingerprint) {
    throw new Error("Idempotency key was already used with a different marketplace admin payload.");
  }
  if (row.status === "completed") {
    const response = readLifecycleReplayResponse(row.metadata);
    if (!response) throw new Error("Completed marketplace admin idempotency key has no response.");
    return response;
  }
  return null;
}

async function reserveMarketplaceAdminLifecycleIdempotency(
  client: Pick<MarketplaceAdminPool, "query">,
  input: {
    operation: MarketplaceAdminLifecycleOperation;
    collaborationId: string;
    idempotencyKey: string;
    keyHash: string;
    fingerprint: string;
  },
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       status,
       tenant_scope,
       correlation_id,
       expires_at,
       idempotency_metadata
     )
     VALUES (
       'marketplace',
       $1,
       $2,
       $3,
       'in_progress',
       'platform',
       $4,
       now() + interval '24 hours',
       $5::jsonb
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      input.operation,
      input.keyHash,
      input.fingerprint,
      input.idempotencyKey,
      JSON.stringify({
        collaborationId: input.collaborationId,
        idempotencyKey: input.idempotencyKey,
      }),
    ],
  );
  return Boolean(result.rows[0]);
}

async function completeMarketplaceAdminLifecycleIdempotency(
  client: Pick<MarketplaceAdminPool, "query">,
  input: {
    operation: MarketplaceAdminLifecycleOperation;
    keyHash: string;
    fingerprint: string;
    response: MarketplaceCollaborationLifecycleWriteResponse;
  },
): Promise<void> {
  await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         request_fingerprint_hash = $1,
         response_status_code = 200,
         response_body_hash = $2,
         response_resource_product = 'marketplace',
         response_resource_type = 'collaboration',
         response_resource_id = $3,
         completed_at = now(),
         last_seen_at = now(),
         idempotency_metadata = idempotency_metadata || $4::jsonb
     WHERE operation_scope = 'marketplace'
       AND operation = $5
       AND key_hash = $6
       AND tenant_scope = 'platform'`,
    [
      input.fingerprint,
      sha256(stableJson(input.response)),
      input.response.collaboration.collaborationId,
      JSON.stringify({ response: input.response }),
      input.operation,
      input.keyHash,
    ],
  );
}

function readLifecycleReplayResponse(
  metadata: unknown,
): MarketplaceCollaborationLifecycleWriteResponse | null {
  if (!isRecord(metadata) || !isRecord(metadata.response)) return null;
  const response = metadata.response;
  if (
    response.contractVersion !== "marketplace-collaboration-lifecycle-writes.v1" ||
    !isRecord(response.command) ||
    !isRecord(response.collaboration) ||
    !Array.isArray(response.sideEffects)
  ) {
    return null;
  }
  return response as MarketplaceCollaborationLifecycleWriteResponse;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original write error.
  }
}

async function readLifecycleWrite(
  pool: Pick<MarketplaceAdminPool, "query">,
  collaborationResourceId: string,
  command: MarketplaceCollaborationLifecycleWriteResponse["command"],
): Promise<MarketplaceCollaborationLifecycleWriteResponse> {
  const row = await pool.query<CollaborationRow>(
    `${COLLABORATION_SELECT_SQL}
     WHERE collaboration.id::text = $1
     LIMIT 1`,
    [collaborationResourceId],
  );
  const collaboration = row.rows[0];
  if (!collaboration) throw new Error("Updated collaboration was not found.");
  return {
    contractVersion: "marketplace-collaboration-lifecycle-writes.v1",
    command,
    collaboration: mapCollaborationRow(collaboration),
    sideEffects: [
      {
        type: "marketplace.collaboration.system_message_requested",
        idempotencyKey: command.idempotencyKey,
      },
    ],
  };
}

type AdminHotelProfile = {
  propertyId: string;
  organizationId: string;
};

async function resolveAdminHotelProfile(
  client: Pick<MarketplaceAdminPool, "query">,
  hotelUserId: string,
): Promise<AdminHotelProfile | null> {
  const result = await client.query<AdminHotelProfile>(
    `SELECT
       profile.property_id::text AS "propertyId",
       profile.organization_id::text AS "organizationId"
     FROM marketplace.marketplace_hotel_profiles profile
     JOIN identity.organization_memberships membership
       ON membership.organization_id = profile.organization_id
      AND membership.user_id::text = $1
      AND membership.status = 'active'
     JOIN identity.organizations organization
       ON organization.id = membership.organization_id
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
     ORDER BY profile.updated_at DESC, profile.property_id ASC
     LIMIT 1`,
    [hotelUserId],
  );
  return result.rows[0] ?? null;
}

async function resolveListingForProfile(
  client: Pick<MarketplaceAdminPool, "query">,
  profile: AdminHotelProfile,
  listingId: string,
): Promise<{ listingResourceId: string; sourceListingId: string; title: string } | null> {
  const result = await client.query<{
    listingResourceId: string;
    sourceListingId: string;
    title: string;
  }>(
    `SELECT
       id::text AS "listingResourceId",
       COALESCE(source_listing_id, id::text) AS "sourceListingId",
       title
     FROM marketplace.marketplace_hotel_listings
     WHERE property_id::text = $1
       AND organization_id::text = $2
       AND (source_listing_id = $3 OR id::text = $3)
       AND listing_status <> 'archived'
     LIMIT 1`,
    [profile.propertyId, profile.organizationId, listingId],
  );
  return result.rows[0] ?? null;
}

async function replaceListingChildren(
  client: Pick<MarketplaceAdminPool, "query">,
  input: {
    listingId: string;
    propertyId: string;
    organizationId: string;
    offerings?: MarketplaceHotelListingOfferingWrite[];
    creatorRequirements?: MarketplaceHotelListingCreatorRequirementsWrite | null;
  },
): Promise<void> {
  if (input.offerings !== undefined) {
    await client.query(
      `DELETE FROM marketplace.listing_collaboration_offerings WHERE listing_id = $1`,
      [input.listingId],
    );
    for (const offering of input.offerings) {
      await client.query(
        `INSERT INTO marketplace.listing_collaboration_offerings (
           listing_id,
           property_id,
           organization_id,
           collaboration_type,
           availability_months,
           platforms,
           free_stay_min_nights,
           free_stay_max_nights,
           paid_max_amount,
           discount_percentage,
           commission_percentage,
           min_followers,
           currency,
           terms_summary
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11::numeric, $12, $13, $14)`,
        [
          input.listingId,
          input.propertyId,
          input.organizationId,
          offering.collaborationType,
          offering.availabilityMonths,
          offering.platforms,
          offering.freeStayMinNights,
          offering.freeStayMaxNights,
          offering.paidMaxAmount,
          offering.discountPercentage,
          offering.commissionPercentage,
          offering.minFollowers,
          offering.currency ?? "USD",
          offering.termsSummary,
        ],
      );
    }
  }

  if (input.creatorRequirements !== undefined) {
    await client.query(
      `DELETE FROM marketplace.listing_creator_requirements WHERE listing_id = $1`,
      [input.listingId],
    );
    if (input.creatorRequirements) {
      await client.query(
        `INSERT INTO marketplace.listing_creator_requirements (
           listing_id,
           property_id,
           organization_id,
           platforms,
           target_countries,
           target_age_min,
           target_age_max,
           target_age_groups,
           creator_types
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.listingId,
          input.propertyId,
          input.organizationId,
          input.creatorRequirements.platforms,
          input.creatorRequirements.targetCountries,
          input.creatorRequirements.targetAgeMin,
          input.creatorRequirements.targetAgeMax,
          input.creatorRequirements.targetAgeGroups,
          input.creatorRequirements.creatorTypes,
        ],
      );
    }
  }
}

async function readListing(
  client: Pick<MarketplaceAdminPool, "query">,
  listingResourceId: string,
  authorizationMode: MarketplaceAdminAuthorizationMode,
): Promise<MarketplaceAdminHotelListing | null> {
  const result = await client.query<ListingRow>(
    `${LISTING_SELECT_SQL}
     WHERE listing.id::text = $1
     LIMIT 1`,
    [listingResourceId],
  );
  const row = result.rows[0];
  return row ? mapListingRow(row, authorizationMode) : null;
}

function buildCollaborationFilters(
  input: {
    status?: MarketplaceCollaborationStatus;
    search?: string;
  },
  params: unknown[],
): string {
  const filters = [];
  if (input.status) {
    params.push(input.status);
    filters.push(`collaboration.lifecycle_status = $${params.length}`);
  }
  if (input.search?.trim()) {
    params.push(`%${input.search.trim()}%`);
    filters.push(`(
      creator.display_name ILIKE $${params.length}
      OR listing.title ILIKE $${params.length}
      OR read_model.display_name ILIKE $${params.length}
    )`);
  }
  return filters.length ? `WHERE ${filters.join(" AND ")}` : "";
}

function mapCollaborationRow(row: CollaborationRow): MarketplaceCollaborationRead {
  const status = toCollaborationStatus(row.status) ?? "pending";
  return {
    contractVersion: "marketplace-collaboration-reads.v1",
    authorizationMode: "hotel_group_resource_link",
    collaborationId: row.collaborationId,
    listingId: row.listingId,
    creatorId: row.creatorId,
    hotelProfileId: row.hotelProfileId,
    side: "hotel",
    initiatorSide: row.initiatorSide === "hotel" ? "hotel" : "creator",
    isInitiator: row.initiatorSide === "hotel",
    status,
    collaborationType: toCollaborationType(row.collaborationType),
    listingName: row.listingName,
    listingLocation: row.listingLocation,
    creator: {
      side: "creator",
      organizationId: row.creatorOrganizationId,
      profileId: row.creatorProfileId,
      displayName: row.creatorName ?? "Creator",
      avatarUrl: row.creatorAvatarUrl,
    },
    hotel: {
      side: "hotel",
      organizationId: row.hotelOrganizationId,
      profileId: row.hotelProfileId,
      displayName: row.hotelName ?? "Hotel",
      avatarUrl: null,
    },
    terms: {
      freeStayMinNights: toNullableNumber(row.freeStayMinNights),
      freeStayMaxNights: toNullableNumber(row.freeStayMaxNights),
      paidAmount: toNullableDecimal(row.paidAmount),
      currency: row.currency ?? null,
      discountPercentage: toNullableNumber(row.discountPercentage),
      creatorFee: toNullableDecimal(row.creatorFee),
      travelDateFrom: toDateString(row.travelDateFrom),
      travelDateTo: toDateString(row.travelDateTo),
      preferredDateFrom: toDateString(row.preferredDateFrom),
      preferredDateTo: toDateString(row.preferredDateTo),
      preferredMonths: row.preferredMonths ?? [],
    },
    deliverables: toDeliverables(row.deliverables),
    lastMessageAt: toIsoStringOrNull(row.lastMessageAt),
    applicationMessage: row.applicationMessage,
    hotelAgreedAt: toIsoStringOrNull(row.hotelAgreedAt),
    creatorAgreedAt: toIsoStringOrNull(row.creatorAgreedAt),
    completedAt: toIsoStringOrNull(row.completedAt),
    cancelledAt: toIsoStringOrNull(row.cancelledAt),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function mapListingRow(
  row: ListingRow,
  authorizationMode: MarketplaceAdminAuthorizationMode,
): MarketplaceAdminHotelListing {
  return {
    contractVersion: MARKETPLACE_ADMIN_CONTRACT_VERSION,
    authorizationMode,
    listingId: row.listingId,
    propertyId: row.propertyId,
    listingStatus: row.listingStatus,
    title: row.title,
    listingSummary: row.listingSummary,
    accommodationType: row.accommodationType,
    rawLocationText: row.rawLocationText,
    imageUrls: row.imageUrls ?? [],
    collaborationOfferings: toOfferings(row.offerings),
    creatorRequirements: toCreatorRequirements(row.creatorRequirements),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function toOfferings(value: unknown): MarketplaceAdminHotelListing["collaborationOfferings"] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((row) => ({
    offeringId: readString(row.offeringId) ?? "",
    collaborationType: toCollaborationType(row.collaborationType) ?? "free_stay",
    availabilityMonths: toStringArray(row.availabilityMonths),
    platforms: toPlatformArray(row.platforms),
    freeStayMinNights: toNullableNumber(row.freeStayMinNights),
    freeStayMaxNights: toNullableNumber(row.freeStayMaxNights),
    paidMaxAmount: toNullableDecimal(row.paidMaxAmount),
    discountPercentage: toNullableNumber(row.discountPercentage),
    commissionPercentage: toNullableNumber(row.commissionPercentage),
    minFollowers: toNullableNumber(row.minFollowers),
    currency: readString(row.currency),
    termsSummary: readString(row.termsSummary),
  }));
}

function toCreatorRequirements(
  value: unknown,
): MarketplaceHotelListingCreatorRequirementsWrite | null {
  if (!isRecord(value) || Object.keys(value).length === 0) return null;
  return {
    platforms: toPlatformArray(value.platforms),
    targetCountries: toStringArray(value.targetCountries),
    targetAgeMin: toNullableNumber(value.targetAgeMin),
    targetAgeMax: toNullableNumber(value.targetAgeMax),
    targetAgeGroups: toStringArray(value.targetAgeGroups),
    creatorTypes: toStringArray(value.creatorTypes)
      .map((type) => (type === "lifestyle" || type === "travel" ? type : "other"))
      .filter((type, index, items) => items.indexOf(type) === index),
  };
}

function toDeliverables(value: unknown): MarketplaceCollaborationDeliverable[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((row, index) => ({
    deliverableId: readString(row.deliverableId) ?? readString(row.id) ?? `deliverable_${index}`,
    platform: readString(row.platform) ?? "custom",
    type: readString(row.type) ?? "Custom",
    quantity: toNullableNumber(row.quantity) ?? 1,
    status: row.status === "completed" ? "completed" : "pending",
    completedAt: toIsoStringOrNull(row.completedAt ?? row.completed_at),
  }));
}

function toCollaborationStatus(value: unknown): MarketplaceCollaborationStatus | undefined {
  switch (value) {
    case "pending":
    case "negotiating":
    case "accepted":
    case "active":
    case "completed":
    case "cancelled":
    case "rejected":
    case "declined":
      return value;
    default:
      return undefined;
  }
}

function toCollaborationType(
  value: unknown,
): MarketplaceHotelListingOfferingWrite["collaborationType"] | null {
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

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return parsed > 0 ? parsed : fallback;
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

function toDateString(value: Date | string | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

type AdminCollaborationsQuery = {
  page?: string | string[];
  pageSize?: string | string[];
  page_size?: string | string[];
  status?: string | string[];
  search?: string | string[];
};

type CollaborationParams = {
  collaborationId: string;
};

type HotelUserParams = {
  hotelUserId: string;
};

type ListingParams = HotelUserParams & {
  listingId: string;
};

type RespondBody = {
  status?: "accepted" | "declined";
  responseMessage?: string;
  response_message?: string;
  idempotencyKey?: string;
};

type ApproveBody = {
  idempotencyKey?: string;
};

type CollaborationRow = {
  id: string;
  collaborationId: string;
  listingId: string;
  creatorId: string;
  hotelProfileId: string;
  creatorProfileId: string;
  creatorOrganizationId: string;
  hotelOrganizationId: string;
  initiatorSide: string;
  status: string;
  collaborationType: string | null;
  listingName: string;
  listingLocation: string | null;
  creatorName: string | null;
  creatorAvatarUrl: string | null;
  hotelName: string | null;
  freeStayMinNights: number | string | null;
  freeStayMaxNights: number | string | null;
  paidAmount: number | string | null;
  currency: string | null;
  discountPercentage: number | string | null;
  creatorFee: number | string | null;
  travelDateFrom: Date | string | null;
  travelDateTo: Date | string | null;
  preferredDateFrom: Date | string | null;
  preferredDateTo: Date | string | null;
  preferredMonths: string[] | null;
  deliverables: unknown;
  lastMessageAt: Date | string | null;
  applicationMessage: string | null;
  hotelAgreedAt: Date | string | null;
  creatorAgreedAt: Date | string | null;
  completedAt: Date | string | null;
  cancelledAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type ListingRow = {
  listingId: string;
  propertyId: string;
  listingStatus: MarketplaceAdminHotelListing["listingStatus"];
  title: string;
  listingSummary: string | null;
  accommodationType: MarketplaceAdminCreateHotelListingRequest["accommodationType"];
  rawLocationText: string | null;
  imageUrls: string[] | null;
  offerings: unknown;
  creatorRequirements: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
};

const COLLABORATION_SELECT_SQL = `
  SELECT
    collaboration.id::text AS id,
    COALESCE(collaboration.source_collaboration_id, collaboration.id::text) AS "collaborationId",
    COALESCE(listing.source_listing_id, listing.id::text) AS "listingId",
    COALESCE(creator.source_creator_id, creator.id::text) AS "creatorId",
    COALESCE(profile.source_hotel_profile_id, profile.property_id::text) AS "hotelProfileId",
    creator.id::text AS "creatorProfileId",
    creator.organization_id::text AS "creatorOrganizationId",
    listing.organization_id::text AS "hotelOrganizationId",
    collaboration.initiator_type AS "initiatorSide",
    collaboration.lifecycle_status AS status,
    collaboration.collaboration_type AS "collaborationType",
    listing.title AS "listingName",
    listing.raw_location_text AS "listingLocation",
    creator.display_name AS "creatorName",
    creator.profile_picture_url AS "creatorAvatarUrl",
    read_model.display_name AS "hotelName",
    collaboration.free_stay_min_nights AS "freeStayMinNights",
    collaboration.free_stay_max_nights AS "freeStayMaxNights",
    collaboration.paid_amount AS "paidAmount",
    collaboration.currency AS currency,
    collaboration.discount_percentage AS "discountPercentage",
    collaboration.creator_fee AS "creatorFee",
    collaboration.travel_date_from AS "travelDateFrom",
    collaboration.travel_date_to AS "travelDateTo",
    collaboration.preferred_date_from AS "preferredDateFrom",
    collaboration.preferred_date_to AS "preferredDateTo",
    collaboration.preferred_months AS "preferredMonths",
    collaboration.platform_deliverables AS deliverables,
    messages.last_message_at AS "lastMessageAt",
    collaboration.application_message AS "applicationMessage",
    collaboration.hotel_agreed_at AS "hotelAgreedAt",
    collaboration.creator_agreed_at AS "creatorAgreedAt",
    collaboration.completed_at AS "completedAt",
    collaboration.cancelled_at AS "cancelledAt",
    collaboration.created_at AS "createdAt",
    collaboration.updated_at AS "updatedAt"
  FROM marketplace.collaborations collaboration
  JOIN marketplace.creator_profiles creator
    ON creator.id = collaboration.creator_profile_id
   AND creator.organization_id = collaboration.creator_organization_id
  JOIN marketplace.marketplace_hotel_listings listing
    ON listing.id = collaboration.listing_id
   AND listing.property_id = collaboration.property_id
   AND listing.organization_id = collaboration.hotel_organization_id
  JOIN marketplace.marketplace_hotel_profiles profile
    ON profile.property_id = listing.property_id
   AND profile.organization_id = listing.organization_id
  LEFT JOIN marketplace.marketplace_listing_read_model read_model
    ON read_model.listing_id = listing.id
   AND read_model.property_id = listing.property_id
  LEFT JOIN LATERAL (
    SELECT max(created_at) AS last_message_at
    FROM marketplace.marketplace_chat_messages message
    WHERE message.collaboration_id = collaboration.id
      AND message.property_id = collaboration.property_id
  ) messages ON TRUE
`;

const COLLABORATION_MUTATION_CTE = `
  WITH matched AS (
    SELECT id
    FROM marketplace.collaborations
    WHERE source_collaboration_id = $1 OR id::text = $1
    LIMIT 1
  )
`;

const LISTING_SELECT_SQL = `
  SELECT
    COALESCE(listing.source_listing_id, listing.id::text) AS "listingId",
    listing.property_id::text AS "propertyId",
    listing.listing_status AS "listingStatus",
    listing.title,
    listing.listing_summary AS "listingSummary",
    listing.accommodation_type AS "accommodationType",
    listing.raw_location_text AS "rawLocationText",
    listing.image_urls AS "imageUrls",
    COALESCE(offerings.items, '[]'::jsonb) AS offerings,
    COALESCE(requirements.item, '{}'::jsonb) AS "creatorRequirements",
    listing.created_at AS "createdAt",
    listing.updated_at AS "updatedAt"
  FROM marketplace.marketplace_hotel_listings listing
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'offeringId', offering.id::text,
        'collaborationType', offering.collaboration_type,
        'availabilityMonths', offering.availability_months,
        'platforms', offering.platforms,
        'freeStayMinNights', offering.free_stay_min_nights,
        'freeStayMaxNights', offering.free_stay_max_nights,
        'paidMaxAmount', offering.paid_max_amount,
        'discountPercentage', offering.discount_percentage,
        'commissionPercentage', offering.commission_percentage,
        'minFollowers', offering.min_followers,
        'currency', offering.currency,
        'termsSummary', offering.terms_summary
      )
      ORDER BY offering.created_at ASC, offering.id ASC
    ) AS items
    FROM marketplace.listing_collaboration_offerings offering
    WHERE offering.listing_id = listing.id
  ) offerings ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'platforms', requirement.platforms,
      'targetCountries', COALESCE(requirement.target_countries, '{}'),
      'targetAgeMin', requirement.target_age_min,
      'targetAgeMax', requirement.target_age_max,
      'targetAgeGroups', requirement.target_age_groups,
      'creatorTypes', requirement.creator_types
    ) AS item
    FROM marketplace.listing_creator_requirements requirement
    WHERE requirement.listing_id = listing.id
    LIMIT 1
  ) requirements ON TRUE
`;
