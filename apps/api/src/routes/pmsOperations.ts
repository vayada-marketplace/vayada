import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type {
  PmsOperationsReadRepository,
  PmsRoom,
  PmsRoomType,
  PmsSourceFreshness,
} from "../domains/pmsOperationsReadModel.js";
import { enforceRoutePolicy } from "./policy.js";

export const PMS_OPERATIONS_CONTRACT_VERSION = "pms-operations.v1" as const;

export type PmsOperationsContractVersion = typeof PMS_OPERATIONS_CONTRACT_VERSION;
export type {
  PmsOperationsReadRepository,
  PmsRoom,
  PmsRoomType,
} from "../domains/pmsOperationsReadModel.js";

export type PmsRoomsResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  items: PmsRoom[];
  sourceFreshness: PmsSourceFreshness;
};

export type PmsRoomTypesResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  items: PmsRoomType[];
  sourceFreshness: PmsSourceFreshness;
};

export type PmsRoomTypeDetailResponse = {
  contractVersion: PmsOperationsContractVersion;
  propertyId: string;
  item: PmsRoomType;
  sourceFreshness: PmsSourceFreshness;
};

export type PmsOperationsRoutesOptions = {
  repository: PmsOperationsReadRepository;
  allowedOrigins?: string[];
};

type PmsPropertyParams = {
  propertyId: string;
};

type PmsRoomTypeParams = PmsPropertyParams & {
  roomTypeId: string;
};

type PmsOperationsErrorCategory = "authentication" | "authorization" | "read_model" | "not_found";

type PmsOperationsErrorCode =
  | "unauthenticated"
  | "invalid_token"
  | "missing_permission"
  | "missing_entitlement"
  | "inactive_entitlement"
  | "missing_resource_access"
  | "read_model_unavailable"
  | "room_type_not_found";

type PmsOperationsError = {
  statusCode: 401 | 403 | 404 | 500;
  code: PmsOperationsErrorCode;
  category: PmsOperationsErrorCategory;
  message: string;
};

export async function registerPmsOperationsRoutes(
  app: FastifyInstance,
  options: PmsOperationsRoutesOptions,
): Promise<void> {
  const { repository } = options;

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  for (const path of [
    "/properties/:propertyId/rooms",
    "/properties/:propertyId/room-types",
    "/properties/:propertyId/room-types/:roomTypeId",
  ]) {
    app.options(path, async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      return reply.code(204).send();
    });
  }

  app.get<{ Params: PmsPropertyParams }>(
    "/properties/:propertyId/rooms",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      try {
        const result = await repository.listRoomsByPropertyId(propertyId);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          items: result.items,
          sourceFreshness: result.sourceFreshness ?? {},
        } satisfies PmsRoomsResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS rooms read model is unavailable."),
        );
      }
    },
  );

  app.get<{ Params: PmsPropertyParams }>(
    "/properties/:propertyId/room-types",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      try {
        const result = await repository.listRoomTypesByPropertyId(propertyId);
        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          items: result.items,
          sourceFreshness: result.sourceFreshness ?? {},
        } satisfies PmsRoomTypesResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS room types read model is unavailable."),
        );
      }
    },
  );

  app.get<{ Params: PmsRoomTypeParams }>(
    "/properties/:propertyId/room-types/:roomTypeId",
    async (request, reply) => {
      if (!writePmsOperationsCorsHeaders(request, reply, options.allowedOrigins ?? [])) {
        return sendPmsOperationsError(reply, {
          statusCode: 403,
          code: "missing_permission",
          category: "authorization",
          message: "PMS operations origin is not allowed.",
        });
      }
      const { propertyId, roomTypeId } = request.params;
      if (!enforcePmsOperationsReadPolicy(request, reply, propertyId)) return reply;

      try {
        const item = await repository.findRoomTypeById(propertyId, roomTypeId);
        if (!item) {
          return sendPmsOperationsError(reply, {
            statusCode: 404,
            code: "room_type_not_found",
            category: "not_found",
            message: "PMS room type not found.",
          });
        }

        return {
          contractVersion: PMS_OPERATIONS_CONTRACT_VERSION,
          propertyId,
          item,
          sourceFreshness: {},
        } satisfies PmsRoomTypeDetailResponse;
      } catch {
        return sendPmsOperationsError(
          reply,
          readModelUnavailable("PMS room types read model is unavailable."),
        );
      }
    },
  );
}

function enforcePmsOperationsReadPolicy(
  request: FastifyRequest,
  reply: FastifyReply,
  propertyId: string,
): boolean {
  try {
    enforceRoutePolicy(request, {
      permission: "pms.operations.read",
      entitlement: {
        product: "pms",
        key: "property-management",
        resource: {
          product: "pms",
          resourceType: "pms_property",
          resourceId: propertyId,
        },
      },
      resource: {
        product: "pms",
        resourceType: "pms_property",
        resourceId: propertyId,
        allowedRelationships: ["owner", "operator", "front_desk"],
      },
    });
    return true;
  } catch (error) {
    const contractError = toPmsOperationsAccessError(error, request, propertyId);
    if (!contractError) throw error;
    sendPmsOperationsError(reply, contractError);
    return false;
  }
}

function sendPmsOperationsError(reply: FastifyReply, error: PmsOperationsError): FastifyReply {
  return reply.status(error.statusCode).send(error);
}

function writePmsOperationsCorsHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: string[],
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (!allowedOrigins.includes(origin)) return false;
  reply
    .header("Access-Control-Allow-Origin", origin)
    .header("Access-Control-Allow-Headers", "authorization,content-type,x-hotel-id")
    .header("Access-Control-Allow-Methods", "GET,OPTIONS")
    .header("Vary", "Origin");
  return true;
}

function readModelUnavailable(message: string): PmsOperationsError {
  return {
    statusCode: 500,
    code: "read_model_unavailable",
    category: "read_model",
    message,
  };
}

function toPmsOperationsAccessError(
  error: unknown,
  request: FastifyRequest,
  propertyId: string,
): PmsOperationsError | null {
  if (!isStatusError(error)) return null;

  if (error.statusCode === 401) {
    return {
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    };
  }

  if (error.statusCode !== 403) return null;

  const code = toPmsOperationsAuthorizationCode(error.message, request, propertyId);
  return {
    statusCode: 403,
    code,
    category: "authorization",
    message: toPmsOperationsAuthorizationMessage(code),
  };
}

function toPmsOperationsAuthorizationCode(
  message: string,
  request: FastifyRequest,
  propertyId: string,
): Exclude<
  PmsOperationsErrorCode,
  "unauthenticated" | "invalid_token" | "read_model_unavailable" | "room_type_not_found"
> {
  const normalized = message.toLowerCase();
  if (normalized.includes("permission")) return "missing_permission";
  if (normalized.includes("entitlement")) {
    return hasInactivePmsOperationsEntitlement(request, propertyId)
      ? "inactive_entitlement"
      : "missing_entitlement";
  }
  return "missing_resource_access";
}

function toPmsOperationsAuthorizationMessage(
  code: Exclude<
    PmsOperationsErrorCode,
    "unauthenticated" | "invalid_token" | "read_model_unavailable" | "room_type_not_found"
  >,
): string {
  switch (code) {
    case "missing_permission":
      return "Missing required PMS operations permission.";
    case "inactive_entitlement":
      return "PMS property-management entitlement is not active.";
    case "missing_entitlement":
      return "Missing active PMS property-management entitlement.";
    case "missing_resource_access":
      return "Missing PMS property access.";
  }
}

function hasInactivePmsOperationsEntitlement(request: FastifyRequest, propertyId: string): boolean {
  return (
    request.authContext?.entitlements.some((entitlement) => {
      if (entitlement.product !== "pms" || entitlement.key !== "property-management") {
        return false;
      }
      if (entitlement.status === "active") return false;
      if (!entitlement.resource) return true;
      return (
        entitlement.resource.product === "pms" &&
        entitlement.resource.resourceType === "pms_property" &&
        entitlement.resource.resourceId === propertyId
      );
    }) ?? false
  );
}

function isStatusError(error: unknown): error is Error & { statusCode: number } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}
