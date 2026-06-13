import {
  COLLABORATION_STATUSES,
  MARKETPLACE_COLLABORATION_AUTHORIZATION_SIDES,
  MARKETPLACE_COLLABORATION_CREATOR_READ_POLICY,
  MARKETPLACE_COLLABORATION_HOTEL_READ_POLICY,
  MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
  type CollaborationStatus,
  type MarketplaceCollaborationAuthorizationMode,
  type MarketplaceCollaborationAuthorizationSide,
  type MarketplaceCollaborationListResponse,
  type MarketplaceCollaborationMessage,
  type MarketplaceCollaborationMessagesResponse,
  type MarketplaceCollaborationRead,
  type MarketplaceConversationSummary,
} from "@vayada/domain-marketplace";
import type { RequestContext } from "@vayada/backend-auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { enforceRoutePolicy } from "./policy.js";

export type MarketplaceCollaborationListFilters = {
  side: MarketplaceCollaborationAuthorizationSide;
  status?: CollaborationStatus;
  initiatedBy?: MarketplaceCollaborationAuthorizationSide;
  listingId?: string;
};

export type MarketplaceCollaborationMessageFilters = {
  before?: string;
};

export type MarketplaceCollaborationReadRepository = {
  listCollaborations(input: {
    context: RequestContext;
    filters: MarketplaceCollaborationListFilters;
  }): Promise<MarketplaceCollaborationListResponse>;
  getCollaboration(input: {
    context: RequestContext;
    collaborationId: string;
    side: MarketplaceCollaborationAuthorizationSide;
  }): Promise<MarketplaceCollaborationRead | null>;
  listConversations(input: {
    context: RequestContext;
    side?: MarketplaceCollaborationAuthorizationSide;
  }): Promise<MarketplaceConversationSummary[]>;
  listMessages(input: {
    context: RequestContext;
    collaborationId: string;
    side: MarketplaceCollaborationAuthorizationSide;
    filters: MarketplaceCollaborationMessageFilters;
  }): Promise<MarketplaceCollaborationMessagesResponse | null>;
  close?(): Promise<void>;
};

export type MarketplaceCollaborationReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

export type MarketplaceCollaborationRoutesOptions = {
  repository: MarketplaceCollaborationReadRepository;
};

type MarketplaceCollaborationRow = {
  collaborationId: string;
  authorizationMode: MarketplaceCollaborationAuthorizationMode;
  listingId: string;
  creatorId: string;
  hotelProfileId: string;
  side: MarketplaceCollaborationAuthorizationSide;
  initiatorSide: string;
  status: string;
  collaborationType: string | null;
  listingName: string;
  listingLocation: string | null;
  creatorProfileId: string;
  creatorOrganizationId: string;
  creatorDisplayName: string | null;
  creatorAvatarUrl: string | null;
  hotelProfileResourceId: string;
  hotelOrganizationId: string;
  hotelDisplayName: string;
  hotelAvatarUrl: string | null;
  freeStayMinNights: number | null;
  freeStayMaxNights: number | null;
  paidAmount: string | null;
  currency: string | null;
  discountPercentage: number | null;
  creatorFee: string | null;
  travelDateFrom: Date | string | null;
  travelDateTo: Date | string | null;
  preferredDateFrom: Date | string | null;
  preferredDateTo: Date | string | null;
  preferredMonths: string[] | null;
  deliverables: unknown;
  lastMessageAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type MarketplaceConversationRow = {
  collaborationId: string;
  side: MarketplaceCollaborationAuthorizationSide;
  partnerName: string | null;
  partnerAvatarUrl: string | null;
  listingName: string | null;
  collaborationStatus: string;
  lastMessageContent: string | null;
  lastMessageAt: Date | string | null;
  unreadCount: string | number | null;
};

type MarketplaceMessageRow = {
  messageId: string;
  collaborationId: string;
  senderUserId: string | null;
  senderName: string | null;
  senderAvatarUrl: string | null;
  content: string;
  contentType: string;
  metadata: unknown;
  createdAt: Date | string;
};

type CollaborationListQuery = {
  side?: string;
  status?: string;
  initiatedBy?: string;
  listingId?: string;
};

type CollaborationSideQuery = {
  side?: string;
};

type CollaborationMessagesQuery = CollaborationSideQuery & {
  before?: string;
};

type CollaborationParams = {
  collaborationId: string;
};

export function registerMarketplaceCollaborationRoutes(
  app: FastifyInstance,
  options: MarketplaceCollaborationRoutesOptions,
): void {
  app.get<{ Querystring: CollaborationListQuery }>("/collaborations/me", async (request, reply) => {
    const side = parseRequiredSide(request.query.side);
    if (!side.ok) {
      return sendMarketplaceCollaborationError(reply, side.error);
    }
    const status = parseOptionalStatus(request.query.status);
    if (!status.ok) {
      return sendMarketplaceCollaborationError(reply, status.error);
    }
    const initiatedBy = parseOptionalSide(request.query.initiatedBy, "initiatedBy");
    if (!initiatedBy.ok) {
      return sendMarketplaceCollaborationError(reply, initiatedBy.error);
    }

    const authorization = authorizeRequiredSideCollaborationRead(request, side.value);
    if (!authorization.ok) {
      return sendMarketplaceCollaborationError(reply, authorization.error);
    }
    return options.repository.listCollaborations({
      context: authorization.context,
      filters: {
        side: side.value,
        status: status.value,
        initiatedBy: initiatedBy.value,
        listingId: normalizeOptionalString(request.query.listingId),
      },
    });
  });

  app.get<{ Querystring: CollaborationSideQuery }>(
    "/collaborations/conversations",
    async (request, reply) => {
      const authorization = authorizeOptionalSideCollaborationRead(request, request.query.side);
      if (!authorization.ok) {
        return sendMarketplaceCollaborationError(reply, authorization.error);
      }

      const items = await options.repository.listConversations({
        context: authorization.context,
        side: authorization.side,
      });
      return items;
    },
  );

  app.get<{ Params: CollaborationParams; Querystring: CollaborationSideQuery }>(
    "/collaborations/:collaborationId",
    async (request, reply) => {
      const side = parseRequiredSide(request.query.side);
      if (!side.ok) {
        return sendMarketplaceCollaborationError(reply, side.error);
      }

      const authorization = authorizeRequiredSideCollaborationRead(request, side.value);
      if (!authorization.ok) {
        return sendMarketplaceCollaborationError(reply, authorization.error);
      }
      const collaboration = await options.repository.getCollaboration({
        context: authorization.context,
        collaborationId: request.params.collaborationId,
        side: side.value,
      });
      if (!collaboration) {
        return sendMarketplaceCollaborationError(reply, {
          statusCode: 404,
          code: "collaboration_not_found",
          message: "Collaboration was not found for the selected marketplace side.",
        });
      }
      return collaboration;
    },
  );

  app.get<{ Params: CollaborationParams; Querystring: CollaborationMessagesQuery }>(
    "/collaborations/:collaborationId/messages",
    async (request, reply) => {
      const authorization = authorizeOptionalSideCollaborationRead(request, request.query.side);
      if (!authorization.ok) {
        return sendMarketplaceCollaborationError(reply, authorization.error);
      }

      const messages = await options.repository.listMessages({
        context: authorization.context,
        collaborationId: request.params.collaborationId,
        side: authorization.side,
        filters: {
          before: normalizeOptionalString(request.query.before),
        },
      });
      if (!messages) {
        return sendMarketplaceCollaborationError(reply, {
          statusCode: 404,
          code: "collaboration_not_found",
          message: "Collaboration messages were not found for the selected marketplace side.",
        });
      }
      return messages;
    },
  );

  app.addHook("onClose", async () => {
    await options.repository.close?.();
  });
}

export function createPgMarketplaceCollaborationReadRepository(config: {
  connectionString: string;
  max?: number;
  pool?: MarketplaceCollaborationReadPool;
}): MarketplaceCollaborationReadRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Marketplace collaboration repository connectionString must not be empty");
  }

  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async listCollaborations({ context, filters }) {
      const rows = await queryCollaborationRows(pool, context, filters.side, {
        status: filters.status,
        initiatedBy: filters.initiatedBy,
        listingId: filters.listingId,
      });
      return toMarketplaceCollaborationListResponse({
        authorizationMode: authorizationModeForSide(filters.side),
        items: rows.map((row) => mapCollaborationRow(row, filters.side)),
      });
    },
    async getCollaboration({ context, collaborationId, side }) {
      const rows = await queryCollaborationRows(pool, context, side, { collaborationId });
      return rows[0] ? mapCollaborationRow(rows[0], side) : null;
    },
    async listConversations({ context, side }) {
      const resolvedSide = side ?? inferSideFromOrganizationKind(context);
      if (!resolvedSide) {
        return [];
      }
      const access = collaborationAccessValues(context, resolvedSide);
      const result = await pool.query<MarketplaceConversationRow>(
        `${collaborationFromSql(resolvedSide, conversationSelectSql(resolvedSide))}
         LEFT JOIN LATERAL (
           SELECT message.body AS "lastMessageContent",
                  message.created_at AS "lastMessageAt"
           FROM marketplace.marketplace_chat_messages message
           WHERE message.collaboration_id = collaboration.id
             AND message.property_id = collaboration.property_id
           ORDER BY message.created_at DESC, message.id DESC
           LIMIT 1
         ) last_message ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::text AS unread_count
           FROM marketplace.marketplace_chat_messages message
           WHERE message.collaboration_id = collaboration.id
             AND message.property_id = collaboration.property_id
             AND message.read_at IS NULL
             AND message.sender_type <> '${resolvedSide}'
         ) unread ON TRUE
         WHERE ${collaborationAccessWhereSql(resolvedSide)}
           AND collaboration.source_collaboration_id IS NOT NULL
         ORDER BY last_message."lastMessageAt" DESC NULLS LAST, collaboration.updated_at DESC
         LIMIT 100`,
        access,
      );
      return result.rows.map((row) => mapConversationRow(row));
    },
    async listMessages({ context, collaborationId, side, filters }) {
      const access = collaborationAccessValues(context, side);
      const collaboration = await pool.query<{ id: string; propertyId: string }>(
        `${collaborationFromSql(side, 'collaboration.id, collaboration.property_id AS "propertyId"')}
         WHERE ${collaborationAccessWhereSql(side)}
           AND collaboration.source_collaboration_id = $${access.length + 1}
         LIMIT 1`,
        [...access, collaborationId],
      );
      const target = collaboration.rows[0];
      if (!target) {
        return null;
      }
      const values: unknown[] = [
        target.id,
        target.propertyId,
        filters.before ?? null,
        collaborationId,
      ];
      const beforeClause = filters.before ? "AND message.created_at < $3" : "";
      const result = await pool.query<MarketplaceMessageRow>(
        `SELECT message.id::text AS "messageId",
                $4::text AS "collaborationId",
                message.sender_user_id::text AS "senderUserId",
                CASE
                  WHEN message.sender_type IN ('system', 'migration') THEN NULL
                  ELSE message.sender_type
                END AS "senderName",
                NULL::text AS "senderAvatarUrl",
                message.body AS content,
                message.message_type AS "contentType",
                message.message_metadata AS metadata,
                message.created_at AS "createdAt"
         FROM marketplace.marketplace_chat_messages message
         WHERE message.collaboration_id = $1
           AND message.property_id = $2
           ${beforeClause}
         ORDER BY message.created_at DESC, message.id DESC
         LIMIT 100`,
        values,
      );
      return toMarketplaceCollaborationMessagesResponse({
        collaborationId,
        authorizationMode: authorizationModeForSide(side),
        items: result.rows.map(mapMessageRow),
      });
    },
    async close() {
      await pool.end();
    },
  };
}

async function queryCollaborationRows(
  pool: MarketplaceCollaborationReadPool,
  context: RequestContext,
  side: MarketplaceCollaborationAuthorizationSide,
  filters: {
    collaborationId?: string;
    status?: CollaborationStatus;
    initiatedBy?: MarketplaceCollaborationAuthorizationSide;
    listingId?: string;
  },
): Promise<MarketplaceCollaborationRow[]> {
  const values: unknown[] = collaborationAccessValues(context, side);
  const clauses = [
    collaborationAccessWhereSql(side),
    "collaboration.source_collaboration_id IS NOT NULL",
  ];
  if (filters.collaborationId) {
    values.push(filters.collaborationId);
    clauses.push(`collaboration.source_collaboration_id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`collaboration.lifecycle_status = $${values.length}`);
  }
  if (filters.initiatedBy) {
    values.push(filters.initiatedBy);
    clauses.push(`collaboration.initiator_type = $${values.length}`);
  }
  if (filters.listingId) {
    values.push(filters.listingId);
    clauses.push(`listing.source_listing_id = $${values.length}`);
  }

  const result = await pool.query<MarketplaceCollaborationRow>(
    `${collaborationFromSql(side)}
     WHERE ${clauses.join("\n       AND ")}
     ORDER BY collaboration.updated_at DESC, collaboration.source_collaboration_id ASC
     LIMIT 100`,
    values,
  );
  return result.rows;
}

function collaborationFromSql(
  side: MarketplaceCollaborationAuthorizationSide,
  select = collaborationSelectSql(side),
): string {
  return `SELECT ${select}
          FROM marketplace.collaborations collaboration
          JOIN marketplace.creator_profiles creator
            ON creator.id = collaboration.creator_profile_id
           AND creator.organization_id = collaboration.creator_organization_id
          JOIN marketplace.marketplace_hotel_listings listing
            ON listing.id = collaboration.listing_id
           AND listing.property_id = collaboration.property_id
           AND listing.organization_id = collaboration.hotel_organization_id
          JOIN marketplace.marketplace_hotel_profiles hotel_profile
            ON hotel_profile.property_id = collaboration.property_id
           AND hotel_profile.organization_id = collaboration.hotel_organization_id
          JOIN hotel_catalog.properties property
            ON property.id = collaboration.property_id
          LEFT JOIN hotel_catalog.property_public_profile_read_model public_profile
            ON public_profile.property_id = collaboration.property_id
          LEFT JOIN LATERAL (
            SELECT jsonb_agg(
                     jsonb_build_object(
                       'deliverableId', deliverable.id::text,
                       'platform', deliverable.platform,
                       'type', deliverable.deliverable_type,
                       'quantity', deliverable.quantity,
                       'status', CASE
                         WHEN deliverable.deliverable_status = 'completed' THEN 'completed'
                         ELSE 'pending'
                       END,
                       'completedAt', deliverable.completed_at
                     )
                     ORDER BY deliverable.created_at ASC, deliverable.id ASC
                   ) AS deliverables
            FROM marketplace.collaboration_deliverables deliverable
            WHERE deliverable.collaboration_id = collaboration.id
              AND deliverable.property_id = collaboration.property_id
          ) deliverables ON TRUE
          LEFT JOIN LATERAL (
            SELECT MAX(message.created_at) AS last_message_at
            FROM marketplace.marketplace_chat_messages message
            WHERE message.collaboration_id = collaboration.id
              AND message.property_id = collaboration.property_id
          ) messages ON TRUE`;
}

function collaborationSelectSql(side: MarketplaceCollaborationAuthorizationSide): string {
  return `collaboration.source_collaboration_id AS "collaborationId",
          '${authorizationModeForSide(side)}'::text AS "authorizationMode",
          listing.source_listing_id AS "listingId",
          creator.source_creator_id AS "creatorId",
          hotel_profile.source_hotel_profile_id AS "hotelProfileId",
          '${side}'::text AS side,
          collaboration.initiator_type AS "initiatorSide",
          collaboration.lifecycle_status AS status,
          collaboration.collaboration_type AS "collaborationType",
          listing.title AS "listingName",
          listing.raw_location_text AS "listingLocation",
          creator.id::text AS "creatorProfileId",
          creator.organization_id::text AS "creatorOrganizationId",
          creator.display_name AS "creatorDisplayName",
          creator.profile_picture_url AS "creatorAvatarUrl",
          hotel_profile.property_id::text AS "hotelProfileResourceId",
          hotel_profile.organization_id::text AS "hotelOrganizationId",
          COALESCE(public_profile.display_name, property.display_name) AS "hotelDisplayName",
          NULL::text AS "hotelAvatarUrl",
          collaboration.free_stay_min_nights AS "freeStayMinNights",
          collaboration.free_stay_max_nights AS "freeStayMaxNights",
          collaboration.paid_amount::text AS "paidAmount",
          collaboration.currency AS currency,
          collaboration.discount_percentage AS "discountPercentage",
          collaboration.creator_fee::text AS "creatorFee",
          collaboration.travel_date_from AS "travelDateFrom",
          collaboration.travel_date_to AS "travelDateTo",
          collaboration.preferred_date_from AS "preferredDateFrom",
          collaboration.preferred_date_to AS "preferredDateTo",
          collaboration.preferred_months AS "preferredMonths",
          COALESCE(deliverables.deliverables, '[]'::jsonb) AS deliverables,
          messages.last_message_at AS "lastMessageAt",
          collaboration.created_at AS "createdAt",
          collaboration.updated_at AS "updatedAt"`;
}

function conversationSelectSql(side: MarketplaceCollaborationAuthorizationSide): string {
  const partnerName =
    side === "creator"
      ? "COALESCE(public_profile.display_name, property.display_name)"
      : "creator.display_name";
  const partnerAvatar = side === "creator" ? "NULL::text" : "creator.profile_picture_url";
  return `collaboration.source_collaboration_id AS "collaborationId",
          '${side}'::text AS side,
          ${partnerName} AS "partnerName",
          ${partnerAvatar} AS "partnerAvatarUrl",
          listing.title AS "listingName",
          collaboration.lifecycle_status AS "collaborationStatus",
          last_message."lastMessageContent",
          last_message."lastMessageAt",
          unread.unread_count AS "unreadCount"`;
}

function collaborationAccessValues(
  context: RequestContext,
  side: MarketplaceCollaborationAuthorizationSide,
): string[][] {
  if (side === "creator") {
    return [activeResourceIds(context, "creator_profile", "owner")];
  }
  return [activeResourceIds(context, "hotel_listing", "operator")];
}

function collaborationAccessWhereSql(side: MarketplaceCollaborationAuthorizationSide): string {
  if (side === "creator") {
    return "creator.id::text = ANY($1::text[])";
  }
  return "listing.id::text = ANY($1::text[])";
}

function activeResourceIds(
  context: RequestContext,
  resourceType: "creator_profile" | "hotel_listing",
  relationship: "owner" | "operator",
): string[] {
  return context.linkedResources
    .filter(
      (resource) =>
        resource.status === "active" &&
        resource.product === "marketplace" &&
        resource.resourceType === resourceType &&
        resource.relationship === relationship,
    )
    .map((resource) => resource.resourceId);
}

function mapCollaborationRow(
  row: MarketplaceCollaborationRow,
  side: MarketplaceCollaborationAuthorizationSide,
): MarketplaceCollaborationRead {
  return {
    contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
    authorizationMode: authorizationModeForSide(side),
    collaborationId: row.collaborationId,
    listingId: row.listingId,
    creatorId: row.creatorId,
    hotelProfileId: row.hotelProfileId,
    side,
    initiatorSide: toCollaborationSide(row.initiatorSide),
    isInitiator: toCollaborationSide(row.initiatorSide) === side,
    status: toCollaborationStatus(row.status),
    collaborationType: toCollaborationType(row.collaborationType),
    listingName: row.listingName,
    listingLocation: row.listingLocation,
    creator: {
      side: "creator",
      organizationId: row.creatorOrganizationId,
      profileId: row.creatorProfileId,
      displayName: row.creatorDisplayName ?? "Creator",
      avatarUrl: row.creatorAvatarUrl,
    },
    hotel: {
      side: "hotel",
      organizationId: row.hotelOrganizationId,
      profileId: row.hotelProfileResourceId,
      displayName: row.hotelDisplayName,
      avatarUrl: row.hotelAvatarUrl,
    },
    terms: {
      freeStayMinNights: row.freeStayMinNights,
      freeStayMaxNights: row.freeStayMaxNights,
      paidAmount: row.paidAmount,
      currency: row.currency,
      discountPercentage: row.discountPercentage,
      creatorFee: row.creatorFee,
      travelDateFrom: toDateString(row.travelDateFrom),
      travelDateTo: toDateString(row.travelDateTo),
      preferredDateFrom: toDateString(row.preferredDateFrom),
      preferredDateTo: toDateString(row.preferredDateTo),
      preferredMonths: Array.isArray(row.preferredMonths) ? row.preferredMonths : [],
    },
    deliverables: toDeliverables(row.deliverables),
    lastMessageAt: toIsoStringOrNull(row.lastMessageAt),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function mapConversationRow(row: MarketplaceConversationRow): MarketplaceConversationSummary {
  return {
    contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
    collaborationId: row.collaborationId,
    side: row.side,
    partnerName: row.partnerName ?? "Marketplace participant",
    partnerAvatarUrl: row.partnerAvatarUrl,
    listingName: row.listingName,
    collaborationStatus: toCollaborationStatus(row.collaborationStatus),
    lastMessageContent: row.lastMessageContent,
    lastMessageAt: toIsoStringOrNull(row.lastMessageAt),
    unreadCount: Number(row.unreadCount ?? 0),
  };
}

function mapMessageRow(row: MarketplaceMessageRow): MarketplaceCollaborationMessage {
  return {
    contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
    messageId: row.messageId,
    collaborationId: row.collaborationId,
    senderUserId: row.senderUserId,
    senderName: row.senderName,
    senderAvatarUrl: row.senderAvatarUrl,
    content: row.content,
    contentType:
      row.contentType === "image" || row.contentType === "system" ? row.contentType : "text",
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : null,
    createdAt: toIsoString(row.createdAt),
  };
}

function toDeliverables(value: unknown): MarketplaceCollaborationRead["deliverables"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    return {
      deliverableId: String(row.deliverableId ?? ""),
      platform: String(row.platform ?? ""),
      type: String(row.type ?? ""),
      quantity: Number(row.quantity ?? 1),
      status: row.status === "completed" ? "completed" : "pending",
      completedAt: toIsoStringOrNull(row.completedAt as Date | string | null | undefined),
    };
  });
}

function toCollaborationStatus(value: string): CollaborationStatus {
  return isCollaborationStatus(value) ? value : "pending";
}

function toCollaborationSide(value: string): MarketplaceCollaborationAuthorizationSide {
  return value === "hotel" ? "hotel" : "creator";
}

function toCollaborationType(
  value: string | null,
): MarketplaceCollaborationRead["collaborationType"] {
  return value === "free_stay" || value === "paid" || value === "discount" || value === "affiliate"
    ? value
    : null;
}

function authorizationModeForSide(
  side: MarketplaceCollaborationAuthorizationSide,
): MarketplaceCollaborationAuthorizationMode {
  return side === "creator" ? "creator_workspace_resource_link" : "hotel_group_resource_link";
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoStringOrNull(value: Date | string | null | undefined): string | null {
  return value ? toIsoString(value) : null;
}

function toDateString(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return value.slice(0, 10);
}

function authorizeRequiredSideCollaborationRead(
  request: FastifyRequest,
  side: MarketplaceCollaborationAuthorizationSide,
): AuthorizationResult {
  const policy =
    side === "creator"
      ? MARKETPLACE_COLLABORATION_CREATOR_READ_POLICY
      : MARKETPLACE_COLLABORATION_HOTEL_READ_POLICY;
  const context = enforceRoutePolicy(request, { permission: policy.permission });
  const expectedKind = policy.selectedOrganizationKind;
  if (context.selectedOrganization.kind !== expectedKind) {
    return {
      ok: false,
      error: {
        statusCode: 403,
        code: "forbidden",
        message: `Selected organization must be ${expectedKind}.`,
      },
    };
  }
  const resourceCheck = checkRequiredResourceLinks(context, side);
  if (!resourceCheck.ok) {
    return resourceCheck;
  }
  return { ok: true, context, side };
}

function authorizeOptionalSideCollaborationRead(
  request: FastifyRequest,
  requestedSide: string | undefined,
): AuthorizationResult {
  const context = enforceRoutePolicy(request, {
    permission: MARKETPLACE_COLLABORATION_CREATOR_READ_POLICY.permission,
  });
  const side = normalizeOptionalString(requestedSide);
  if (side) {
    if (!isCollaborationSide(side)) {
      return {
        ok: false,
        error: {
          statusCode: 400,
          code: "invalid_query",
          message: `side must be one of: ${MARKETPLACE_COLLABORATION_AUTHORIZATION_SIDES.join(", ")}.`,
        },
      };
    }
    const expectedKind =
      side === "creator"
        ? MARKETPLACE_COLLABORATION_CREATOR_READ_POLICY.selectedOrganizationKind
        : MARKETPLACE_COLLABORATION_HOTEL_READ_POLICY.selectedOrganizationKind;
    if (context.selectedOrganization.kind !== expectedKind) {
      return {
        ok: false,
        error: {
          statusCode: 403,
          code: "forbidden",
          message: `Selected organization must be ${expectedKind}.`,
        },
      };
    }
    const resourceCheck = checkRequiredResourceLinks(context, side);
    if (!resourceCheck.ok) {
      return resourceCheck;
    }
    return { ok: true, context, side };
  }

  const inferredSide = inferSideFromOrganizationKind(context);
  if (!inferredSide) {
    return {
      ok: false,
      error: {
        statusCode: 403,
        code: "forbidden",
        message: "Selected organization is not a marketplace collaboration participant.",
      },
    };
  }
  const resourceCheck = checkRequiredResourceLinks(context, inferredSide);
  if (!resourceCheck.ok) {
    return resourceCheck;
  }
  return { ok: true, context, side: inferredSide };
}

function inferSideFromOrganizationKind(
  context: RequestContext,
): MarketplaceCollaborationAuthorizationSide | null {
  if (context.selectedOrganization.kind === "creator_workspace") {
    return "creator";
  }
  if (context.selectedOrganization.kind === "hotel_group") {
    return "hotel";
  }
  return null;
}

function checkRequiredResourceLinks(
  context: RequestContext,
  side: MarketplaceCollaborationAuthorizationSide,
): { ok: true } | { ok: false; error: MarketplaceCollaborationRouteError } {
  const policy =
    side === "creator"
      ? MARKETPLACE_COLLABORATION_CREATOR_READ_POLICY
      : MARKETPLACE_COLLABORATION_HOTEL_READ_POLICY;
  const missing = policy.requiredResources.find(
    (required) =>
      !context.linkedResources.some(
        (resource) =>
          resource.status === "active" &&
          resource.product === required.product &&
          resource.resourceType === required.resourceType &&
          resource.relationship === required.relationship,
      ),
  );
  if (!missing) {
    return { ok: true };
  }

  const code = side === "creator" ? "missing_creator_resource_link" : "missing_hotel_resource_link";
  return {
    ok: false,
    error: {
      statusCode: 403,
      code,
      message: `Missing active ${missing.resourceType} ${missing.relationship} link for marketplace collaboration reads.`,
    },
  };
}

function parseRequiredSide(
  value: string | undefined,
): ParseResult<MarketplaceCollaborationAuthorizationSide> {
  const side = normalizeOptionalString(value);
  if (!side) {
    return invalidQuery("side is required.");
  }
  return parseOptionalSide(side, "side") as ParseResult<MarketplaceCollaborationAuthorizationSide>;
}

function parseOptionalSide(
  value: string | undefined,
  field: string,
): ParseResult<MarketplaceCollaborationAuthorizationSide | undefined> {
  const side = normalizeOptionalString(value);
  if (!side) {
    return { ok: true, value: undefined };
  }
  if (!isCollaborationSide(side)) {
    return invalidQuery(
      `${field} must be one of: ${MARKETPLACE_COLLABORATION_AUTHORIZATION_SIDES.join(", ")}.`,
    );
  }
  return { ok: true, value: side };
}

function parseOptionalStatus(
  value: string | undefined,
): ParseResult<CollaborationStatus | undefined> {
  const status = normalizeOptionalString(value);
  if (!status) {
    return { ok: true, value: undefined };
  }
  if (!isCollaborationStatus(status)) {
    return invalidQuery(`status must be one of: ${COLLABORATION_STATUSES.join(", ")}.`);
  }
  return { ok: true, value: status };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isCollaborationSide(value: string): value is MarketplaceCollaborationAuthorizationSide {
  return (MARKETPLACE_COLLABORATION_AUTHORIZATION_SIDES as readonly string[]).includes(value);
}

function isCollaborationStatus(value: string): value is CollaborationStatus {
  return (COLLABORATION_STATUSES as readonly string[]).includes(value);
}

function sendMarketplaceCollaborationError(
  reply: FastifyReply,
  error: MarketplaceCollaborationRouteError,
): FastifyReply {
  return reply.status(error.statusCode).send({
    code: error.code,
    category:
      error.statusCode === 404 ? "not_found" : error.statusCode === 400 ? "validation" : "auth",
    message: error.message,
  });
}

function invalidQuery<T = never>(message: string): ParseResult<T> {
  return {
    ok: false,
    error: {
      statusCode: 400,
      code: "invalid_query",
      message,
    },
  };
}

type ParseResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: MarketplaceCollaborationRouteError;
    };

type AuthorizationResult =
  | {
      ok: true;
      context: RequestContext;
      side: MarketplaceCollaborationAuthorizationSide;
    }
  | {
      ok: false;
      error: MarketplaceCollaborationRouteError;
    };

type MarketplaceCollaborationRouteError = {
  statusCode: 400 | 403 | 404;
  code:
    | "invalid_query"
    | "forbidden"
    | "missing_creator_resource_link"
    | "missing_hotel_resource_link"
    | "collaboration_not_found";
  message: string;
};

export function toMarketplaceCollaborationListResponse(input: {
  authorizationMode: MarketplaceCollaborationAuthorizationMode;
  items: MarketplaceCollaborationRead[];
}): MarketplaceCollaborationListResponse {
  return {
    contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
    authorizationMode: input.authorizationMode,
    items: input.items,
  };
}

export function toMarketplaceCollaborationMessagesResponse(input: {
  collaborationId: string;
  authorizationMode: MarketplaceCollaborationAuthorizationMode;
  items: MarketplaceCollaborationMessage[];
}): MarketplaceCollaborationMessagesResponse {
  return {
    contractVersion: MARKETPLACE_COLLABORATION_READS_CONTRACT_VERSION,
    collaborationId: input.collaborationId,
    authorizationMode: input.authorizationMode,
    items: input.items,
  };
}
