import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

export type SharedHotelSetupEntryProduct = "booking" | "pms" | "marketplace";
export type SharedPropertyProfileMissingField =
  | "displayName"
  | "location"
  | "website"
  | "phone"
  | "description"
  | "media";

export type SharedProductActivation<Product extends SharedHotelSetupEntryProduct> = {
  product: Product;
  status: "not_selected" | "selected_incomplete" | "active" | "suspended" | "unavailable";
  missingSteps: string[];
  statusReasons: string[];
  updatedAt: string | null;
};

export type SharedSetupProperty = {
  propertyId: string;
  publicId: string;
  displayName: string | null;
  locationSummary: string | null;
  sharedProfile: {
    status: "incomplete" | "complete" | "disabled" | "private";
    completionPercent: number;
    missingFields: SharedPropertyProfileMissingField[];
  };
  products: {
    booking: SharedProductActivation<"booking">;
    pms: SharedProductActivation<"pms">;
    marketplace: SharedProductActivation<"marketplace">;
  };
};

export type SharedHotelSetupNextAction =
  | { action: "create_property"; reasonCodes: string[] }
  | { action: "select_property"; reasonCodes: string[] }
  | {
      action: "complete_shared_profile";
      propertyId: string;
      missingFields: SharedPropertyProfileMissingField[];
      reasonCodes: string[];
    }
  | { action: "select_products"; propertyId: string; reasonCodes: string[] }
  | {
      action: "complete_product_activation";
      propertyId: string;
      product: SharedHotelSetupEntryProduct;
      missingSteps: string[];
      reasonCodes: string[];
    }
  | {
      action: "enter_product";
      propertyId: string;
      product: SharedHotelSetupEntryProduct;
      returnTo: string | null;
      reasonCodes: string[];
    };

export type SharedHotelSetupStatus = {
  contractVersion: "shared-hotel-setup-status.v1";
  entry: {
    entryProduct: SharedHotelSetupEntryProduct | null;
    returnTo: string | null;
  };
  hotelGroup: {
    organizationId: string;
    displayName: string;
  };
  selection: {
    state: "no_property" | "single_property" | "multiple_properties";
    selectedPropertyId: string | null;
  };
  properties: SharedSetupProperty[];
  nextAction: SharedHotelSetupNextAction;
  updatedAt: string;
};

export type SharedHotelSetupStatusRepository = {
  getHotelSetupStatus(input: { organizationId: string; propertyIds: string[] }): Promise<{
    hotelGroupDisplayName: string | null;
    properties: SharedSetupProperty[];
  }>;
  close?(): Promise<void>;
};

type SharedHotelSetupStatusRoutesOptions = {
  repository: SharedHotelSetupStatusRepository;
  now?: () => Date;
};

type SharedHotelSetupQuery = {
  entryProduct?: string;
  returnTo?: string;
  propertyId?: string;
};

const ENTRY_PRODUCTS: readonly SharedHotelSetupEntryProduct[] = ["booking", "pms", "marketplace"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function registerSharedHotelSetupStatusRoutes(
  app: FastifyInstance,
  options: SharedHotelSetupStatusRoutesOptions,
): Promise<void> {
  const { repository, now = () => new Date() } = options;

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get("/status", async (request, reply) => {
    const query = request.query as SharedHotelSetupQuery;
    const entryProduct = parseEntryProduct(query.entryProduct, reply);
    if (entryProduct === false) return reply;

    const requestedPropertyId = parsePropertyId(query.propertyId, reply);
    if (requestedPropertyId === false) return reply;

    const access = resolveSharedSetupAccess(request, reply, requestedPropertyId);
    if (!access) return reply;

    const status = await repository.getHotelSetupStatus({
      organizationId: access.organizationId,
      propertyIds: access.propertyIds,
    });
    const returnTo = safeReturnTo(query.returnTo, request);
    const authorizedProperties = filterAuthorizedProperties(status.properties, access.propertyIds);
    const availablePropertyIds = authorizedProperties.map((property) => property.propertyId);
    const selectedPropertyId =
      requestedPropertyId ??
      (availablePropertyIds.length === 1 ? authorizedProperties[0]!.propertyId : null);

    if (
      selectedPropertyId &&
      !authorizedProperties.some((item) => item.propertyId === selectedPropertyId)
    ) {
      return reply.status(404).send({
        code: "property_setup_status_not_found",
        detail: "Setup status was not found for the selected property.",
      });
    }

    return {
      contractVersion: "shared-hotel-setup-status.v1",
      entry: {
        entryProduct,
        returnTo,
      },
      hotelGroup: {
        organizationId: access.organizationId,
        displayName: status.hotelGroupDisplayName ?? access.organizationId,
      },
      selection: {
        state: selectionState(availablePropertyIds),
        selectedPropertyId,
      },
      properties: authorizedProperties,
      nextAction: nextAction(authorizedProperties, selectedPropertyId, entryProduct, returnTo),
      updatedAt: now().toISOString(),
    } satisfies SharedHotelSetupStatus;
  });
}

function resolveSharedSetupAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  requestedPropertyId: string | null,
): { organizationId: string; propertyIds: string[] } | null {
  try {
    const context = enforceRoutePolicy(request, { permission: "hotel_catalog.setup.read" });
    if (context.selectedOrganization.kind !== "hotel_group") {
      reply.status(403).send({ detail: "This endpoint is only available for hotel groups." });
      return null;
    }

    const propertyIds = unique(
      context.linkedResources
        .filter(
          (resource) =>
            resource.status === "active" &&
            resource.product === "hotel_catalog" &&
            resource.resourceType === "property" &&
            (resource.relationship === "owner" || resource.relationship === "operator") &&
            isUuid(resource.resourceId),
        )
        .map((resource) => resource.resourceId),
    );

    if (requestedPropertyId && !propertyIds.includes(requestedPropertyId)) {
      reply.status(403).send({
        code: "missing_property_resource_link",
        detail: "The selected hotel group is not linked to that property.",
      });
      return null;
    }

    return {
      organizationId: context.selectedOrganization.organizationId,
      propertyIds,
    };
  } catch (error) {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number((error as { statusCode?: unknown }).statusCode)
        : 500;
    if (statusCode === 401 || statusCode === 403) {
      reply.status(statusCode).send({
        detail: error instanceof Error ? error.message : "Forbidden",
      });
      return null;
    }
    throw error;
  }
}

function parseEntryProduct(
  value: string | undefined,
  reply: FastifyReply,
): SharedHotelSetupEntryProduct | null | false {
  if (value === undefined || value === "") return null;
  if ((ENTRY_PRODUCTS as readonly string[]).includes(value)) {
    return value as SharedHotelSetupEntryProduct;
  }
  reply.status(422).send({
    code: "invalid_entry_product",
    detail: "entryProduct must be booking, pms, or marketplace.",
  });
  return false;
}

function parsePropertyId(value: string | undefined, reply: FastifyReply): string | null | false {
  if (value === undefined || value === "") return null;
  if (isUuid(value)) return value;
  reply.status(422).send({
    code: "invalid_property_id",
    detail: "propertyId must be a UUID.",
  });
  return false;
}

function filterAuthorizedProperties(
  properties: SharedSetupProperty[],
  propertyIds: string[],
): SharedSetupProperty[] {
  const authorized = new Set(propertyIds);
  const order = new Map(propertyIds.map((propertyId, index) => [propertyId, index]));
  return properties
    .filter((property) => authorized.has(property.propertyId))
    .sort((left, right) => (order.get(left.propertyId) ?? 0) - (order.get(right.propertyId) ?? 0));
}

function selectionState(propertyIds: string[]): SharedHotelSetupStatus["selection"]["state"] {
  if (propertyIds.length === 0) return "no_property";
  return propertyIds.length === 1 ? "single_property" : "multiple_properties";
}

function nextAction(
  properties: SharedSetupProperty[],
  selectedPropertyId: string | null,
  entryProduct: SharedHotelSetupEntryProduct | null,
  returnTo: string | null,
): SharedHotelSetupNextAction {
  if (properties.length === 0) {
    return { action: "create_property", reasonCodes: ["no_property"] };
  }
  if (!selectedPropertyId) {
    return { action: "select_property", reasonCodes: ["multiple_properties"] };
  }

  const property = properties.find((item) => item.propertyId === selectedPropertyId)!;
  if (property.sharedProfile.status !== "complete") {
    return {
      action: "complete_shared_profile",
      propertyId: property.propertyId,
      missingFields: property.sharedProfile.missingFields,
      reasonCodes: [`shared_profile_${property.sharedProfile.status}`],
    };
  }

  if (entryProduct) {
    const activation = property.products[entryProduct];
    if (activation.status === "active") {
      return {
        action: "enter_product",
        propertyId: property.propertyId,
        product: entryProduct,
        returnTo,
        reasonCodes: ["entry_product_active"],
      };
    }
    if (activation.status === "not_selected") {
      return {
        action: "select_products",
        propertyId: property.propertyId,
        reasonCodes: ["entry_product_not_selected"],
      };
    }
    return {
      action: "complete_product_activation",
      propertyId: property.propertyId,
      product: entryProduct,
      missingSteps: activation.missingSteps,
      reasonCodes: activationReasonCodes(activation, "entry_product_activation_incomplete"),
    };
  }

  const incompleteProduct = ENTRY_PRODUCTS.map((product) => property.products[product]).find(
    (activation) =>
      activation.status === "selected_incomplete" ||
      activation.status === "suspended" ||
      activation.status === "unavailable",
  );
  if (incompleteProduct) {
    return {
      action: "complete_product_activation",
      propertyId: property.propertyId,
      product: incompleteProduct.product,
      missingSteps: incompleteProduct.missingSteps,
      reasonCodes: activationReasonCodes(
        incompleteProduct,
        `${incompleteProduct.product}_activation_incomplete`,
      ),
    };
  }

  const activeProduct = ENTRY_PRODUCTS.map((product) => property.products[product]).find(
    (activation) => activation.status === "active",
  );
  if (activeProduct) {
    return {
      action: "enter_product",
      propertyId: property.propertyId,
      product: activeProduct.product,
      returnTo,
      reasonCodes: ["product_active"],
    };
  }

  return {
    action: "select_products",
    propertyId: property.propertyId,
    reasonCodes: ["no_products_selected"],
  };
}

function activationReasonCodes<Product extends SharedHotelSetupEntryProduct>(
  activation: SharedProductActivation<Product>,
  fallback: string,
): string[] {
  if (activation.missingSteps.length === 0 && activation.statusReasons.length > 0) {
    return activation.statusReasons;
  }
  return [fallback];
}

function safeReturnTo(value: string | undefined, request: FastifyRequest): string | null {
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) {
    return value;
  }

  const origin = request.headers.origin;
  if (!origin) return null;

  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === origin) {
      return url.toString();
    }
  } catch {
    return null;
  }

  return null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
