import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

export const MARKETPLACE_TRIPS_CONTRACT_VERSION = "marketplace-trips-external.v1" as const;

export type MarketplaceTripsContractVersion = typeof MARKETPLACE_TRIPS_CONTRACT_VERSION;
export type MarketplaceTripsAuthorizationMode = "creator_workspace_resource_link";
export type MarketplaceExternalCollaborationType =
  | "custom_external"
  | "paid"
  | "free_stay"
  | "affiliate"
  | "other";

export type MarketplaceExternalCollaboration = {
  contractVersion: MarketplaceTripsContractVersion;
  authorizationMode: MarketplaceTripsAuthorizationMode;
  externalCollaborationId: string;
  creatorProfileId: string;
  organizationId: string;
  tripId: string | null;
  sourceExternalCollaborationId: string | null;
  title: string;
  hotelName: string | null;
  locationText: string | null;
  collaborationType: MarketplaceExternalCollaborationType | null;
  startDate: string;
  endDate: string;
  deliverablesSummary: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceTrip = {
  contractVersion: MarketplaceTripsContractVersion;
  authorizationMode: MarketplaceTripsAuthorizationMode;
  tripId: string;
  creatorProfileId: string;
  organizationId: string;
  sourceTripId: string | null;
  name: string;
  locationText: string | null;
  startDate: string;
  endDate: string;
  notes: string | null;
  externalCollaborations: MarketplaceExternalCollaboration[];
  createdAt: string;
  updatedAt: string;
};

export type MarketplaceTripListResponse = {
  contractVersion: MarketplaceTripsContractVersion;
  authorizationMode: MarketplaceTripsAuthorizationMode;
  creatorProfileId: string;
  organizationId: string;
  items: MarketplaceTrip[];
};

export type MarketplaceExternalCollaborationListResponse = {
  contractVersion: MarketplaceTripsContractVersion;
  authorizationMode: MarketplaceTripsAuthorizationMode;
  creatorProfileId: string;
  organizationId: string;
  items: MarketplaceExternalCollaboration[];
};

export type MarketplaceTripReadRepository = {
  listTripsForCreatorProfile(creatorProfileId: string): Promise<MarketplaceTrip[]>;
  findTripForCreatorProfile(
    creatorProfileId: string,
    tripId: string,
  ): Promise<MarketplaceTrip | null>;
  listExternalCollaborationsForCreatorProfile(
    creatorProfileId: string,
  ): Promise<MarketplaceExternalCollaboration[]>;
  close?(): Promise<void>;
};

export type MarketplaceTripRoutesOptions = {
  repository: MarketplaceTripReadRepository;
};

type TripParams = {
  tripId: string;
};

type MarketplaceTripErrorCategory = "authentication" | "authorization" | "not_found" | "read_model";

type MarketplaceTripErrorCode =
  | "unauthorized"
  | "missing_permission"
  | "forbidden"
  | "missing_creator_resource_link"
  | "trip_not_found"
  | "read_model_unavailable";

export type MarketplaceTripError = {
  statusCode: 401 | 403 | 404 | 500;
  code: MarketplaceTripErrorCode;
  category: MarketplaceTripErrorCategory;
  message: string;
};

export async function registerMarketplaceTripRoutes(
  app: FastifyInstance,
  options: MarketplaceTripRoutesOptions,
): Promise<void> {
  const { repository } = options;

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get("/trips", async (request, reply) => {
    const access = resolveMarketplaceTripAccess(request, reply);
    if (!access) return reply;

    try {
      const items = await repository.listTripsForCreatorProfile(access.creatorProfileId);
      const scopedItems = items.filter((item) => item.organizationId === access.organizationId);
      return {
        contractVersion: MARKETPLACE_TRIPS_CONTRACT_VERSION,
        authorizationMode: "creator_workspace_resource_link",
        creatorProfileId: access.creatorProfileId,
        organizationId: access.organizationId,
        items: scopedItems.map(normalizeTrip),
      } satisfies MarketplaceTripListResponse;
    } catch (error) {
      request.log.error({ error }, "Failed to list marketplace trips");
      return sendMarketplaceTripError(reply, {
        statusCode: 500,
        code: "read_model_unavailable",
        category: "read_model",
        message: "Marketplace trip read model is unavailable.",
      });
    }
  });

  app.get("/trips/external-collaborations", async (request, reply) => {
    const access = resolveMarketplaceTripAccess(request, reply);
    if (!access) return reply;

    try {
      const items = await repository.listExternalCollaborationsForCreatorProfile(
        access.creatorProfileId,
      );
      const scopedItems = items.filter((item) => item.organizationId === access.organizationId);
      return {
        contractVersion: MARKETPLACE_TRIPS_CONTRACT_VERSION,
        authorizationMode: "creator_workspace_resource_link",
        creatorProfileId: access.creatorProfileId,
        organizationId: access.organizationId,
        items: scopedItems.map(normalizeExternalCollaboration),
      } satisfies MarketplaceExternalCollaborationListResponse;
    } catch (error) {
      request.log.error({ error }, "Failed to list marketplace external collaborations");
      return sendMarketplaceTripError(reply, {
        statusCode: 500,
        code: "read_model_unavailable",
        category: "read_model",
        message: "Marketplace external collaboration read model is unavailable.",
      });
    }
  });

  app.get<{ Params: TripParams }>("/trips/:tripId", async (request, reply) => {
    const access = resolveMarketplaceTripAccess(request, reply);
    if (!access) return reply;

    try {
      const trip = await repository.findTripForCreatorProfile(
        access.creatorProfileId,
        request.params.tripId,
      );
      if (!trip || trip.organizationId !== access.organizationId) {
        return sendMarketplaceTripError(reply, {
          statusCode: 404,
          code: "trip_not_found",
          category: "not_found",
          message: "Marketplace trip was not found.",
        });
      }
      return normalizeTrip(trip);
    } catch (error) {
      request.log.error({ error }, "Failed to read marketplace trip");
      return sendMarketplaceTripError(reply, {
        statusCode: 500,
        code: "read_model_unavailable",
        category: "read_model",
        message: "Marketplace trip read model is unavailable.",
      });
    }
  });
}

function resolveMarketplaceTripAccess(
  request: FastifyRequest,
  reply: FastifyReply,
): { creatorProfileId: string; organizationId: string } | null {
  try {
    const context = enforceRoutePolicy(request, { permission: "marketplace.trip.read" });

    if (context.selectedOrganization.kind !== "creator_workspace") {
      sendMarketplaceTripError(reply, {
        statusCode: 403,
        code: "forbidden",
        category: "authorization",
        message: "Marketplace trips require a selected creator workspace.",
      });
      return null;
    }

    const creatorLinks = context.linkedResources.filter(
      (resource) =>
        resource.product === "marketplace" &&
        resource.resourceType === "creator_profile" &&
        resource.relationship === "owner" &&
        resource.status === "active",
    );

    if (creatorLinks.length === 0) {
      sendMarketplaceTripError(reply, {
        statusCode: 403,
        code: "missing_creator_resource_link",
        category: "authorization",
        message: "Missing marketplace creator profile access.",
      });
      return null;
    }

    if (creatorLinks.length > 1) {
      sendMarketplaceTripError(reply, {
        statusCode: 403,
        code: "forbidden",
        category: "authorization",
        message: "Marketplace trips require exactly one selected creator profile.",
      });
      return null;
    }

    const [creatorLink] = creatorLinks;

    enforceRoutePolicy(request, {
      permission: "marketplace.trip.read",
      resource: {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: creatorLink.resourceId,
        allowedRelationships: ["owner"],
      },
    });

    return {
      creatorProfileId: creatorLink.resourceId,
      organizationId: context.selectedOrganization.organizationId,
    };
  } catch (error) {
    const contractError = toMarketplaceTripAccessError(error);
    if (!contractError) throw error;
    sendMarketplaceTripError(reply, contractError);
    return null;
  }
}

function normalizeTrip(trip: MarketplaceTrip): MarketplaceTrip {
  return {
    ...trip,
    contractVersion: MARKETPLACE_TRIPS_CONTRACT_VERSION,
    authorizationMode: "creator_workspace_resource_link",
    startDate: normalizeDate(trip.startDate),
    endDate: normalizeDate(trip.endDate),
    createdAt: normalizeDateTime(trip.createdAt),
    updatedAt: normalizeDateTime(trip.updatedAt),
    externalCollaborations: trip.externalCollaborations.map(normalizeExternalCollaboration),
  };
}

function normalizeExternalCollaboration(
  collaboration: MarketplaceExternalCollaboration,
): MarketplaceExternalCollaboration {
  return {
    ...collaboration,
    contractVersion: MARKETPLACE_TRIPS_CONTRACT_VERSION,
    authorizationMode: "creator_workspace_resource_link",
    startDate: normalizeDate(collaboration.startDate),
    endDate: normalizeDate(collaboration.endDate),
    createdAt: normalizeDateTime(collaboration.createdAt),
    updatedAt: normalizeDateTime(collaboration.updatedAt),
  };
}

function normalizeDate(value: string): string {
  return value.includes("T") ? value.split("T")[0] : value;
}

function normalizeDateTime(value: string): string {
  return value.includes("T") ? value : new Date(value).toISOString();
}

function toMarketplaceTripAccessError(error: unknown): MarketplaceTripError | null {
  const statusCode =
    typeof error === "object" && error !== null && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
  if (statusCode === 401) {
    return {
      statusCode: 401,
      code: "unauthorized",
      category: "authentication",
      message: "A valid access token is required.",
    };
  }
  if (statusCode !== 403) return null;

  const message = error instanceof Error ? error.message : "Missing marketplace trip access.";
  if (message.toLowerCase().includes("permission")) {
    return {
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required marketplace trip permission.",
    };
  }
  return {
    statusCode: 403,
    code: "missing_creator_resource_link",
    category: "authorization",
    message: "Missing marketplace creator profile access.",
  };
}

function sendMarketplaceTripError(reply: FastifyReply, error: MarketplaceTripError): FastifyReply {
  return reply.status(error.statusCode).send(error);
}
