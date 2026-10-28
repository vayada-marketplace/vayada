// The Creator Marketplace track is retired (VAY-2270); Hotel Operations is the only setup track.
export const SETUP_TRACKS = Object.freeze(["hotel_operations"] as const);

export type SetupTrack = (typeof SETUP_TRACKS)[number];

export const SETUP_TRACK_COMPONENT_PRODUCTS = Object.freeze({
  hotel_operations: Object.freeze(["pms", "booking"] as const),
}) satisfies Record<SetupTrack, readonly string[]>;

/** The tracks a hotel can choose: every setup track. */
export const OFFERED_SETUP_TRACKS = SETUP_TRACKS;

/**
 * Reads stored track selections in canonical order, dropping unknown values. Stored rows may still
 * name the retired creator_marketplace track until the data migration rewrites them.
 */
export function normalizeStoredSetupTracks(values: readonly unknown[]): SetupTrack[] {
  return SETUP_TRACKS.filter((track) => values.includes(track));
}

export type UpdateTracksRequest = {
  selectedTracks: SetupTrack[];
  expectedRevision: number;
};

export type SetupComponentProduct = "pms" | "booking";

export type TrackStatus = {
  track: SetupTrack;
  provisioning: "not_selected" | "active" | "blocked";
  components: Array<{
    product: SetupComponentProduct;
    access: "absent" | "active" | "suspended" | "unavailable";
  }>;
  allowedActions: Array<"add" | "manage_service">;
};

export type UpdateTracksResponse = {
  trackRevision: number;
  selectedTracks: SetupTrack[];
  tracks: TrackStatus[];
};

export type SetupCommandError = {
  code:
    | "invalid_setup_request"
    | "track_revision_conflict"
    | "idempotency_key_conflict"
    | "command_in_progress"
    | "track_removal_requires_service_management"
    | "profile_revision_conflict"
    | "missing_property_resource_link";
  currentRevision?: number;
};

export const ADAPTIVE_HOTEL_SETUP_CONTRACT_VERSION = "adaptive-hotel-setup.v1" as const;
// The hotel-basics task is the only setup task; the API stopped computing the others (VAY-2175).
export const SETUP_TASK_IDS = ["shared_identity"] as const;
export const SETUP_TASK_DESTINATION_ROUTE_KEYS = {
  shared_identity: "hotel_catalog.shared_identity",
} as const satisfies Record<(typeof SETUP_TASK_IDS)[number], string>;
export const SETUP_TASK_TRACKS = ["shared", ...SETUP_TRACKS] as const;
export const SETUP_REQUIREMENT_OWNER_DOMAINS = [
  "hotel_catalog",
  "pms",
  "booking",
  "finance",
  "distribution",
] as const;
export const SETUP_CALLER_CAPABILITIES = ["allowed", "ask_owner", "forbidden", "waiting"] as const;
export const SETUP_OWNER_PROGRESS_STATES = [
  "not_started",
  "in_progress",
  "owner_complete",
] as const;
export const SETUP_TASK_READINESS_STATES = [
  "actionable",
  "blocked",
  "pending_sync",
  "pending_review",
  "rejected",
  "complete",
] as const;
export const SETUP_ACTIONABLE_BY = ["owner", "operator", "support", "system"] as const;
export const SETUP_FACT_FRESHNESS = ["fresh", "stale"] as const;
export const PRODUCT_ENTRY_PRODUCTS = ["booking", "pms"] as const;
export const PRODUCT_ENTRY_DECISIONS = ["enter", "setup_required", "unavailable"] as const;
export const PROPERTY_SELECTION_STATES = [
  "no_property",
  "single_property",
  "multiple_properties",
] as const;
export type SetupTaskId = (typeof SETUP_TASK_IDS)[number];
export type SetupTask = {
  taskId: SetupTaskId;
  propertyId: string;
  track: "shared" | SetupTrack;
  requirementOwnerDomain: (typeof SETUP_REQUIREMENT_OWNER_DOMAINS)[number];
  destinationRouteKey: string;
  callerCapability: (typeof SETUP_CALLER_CAPABILITIES)[number];
  ownerProgress: (typeof SETUP_OWNER_PROGRESS_STATES)[number];
  readiness: (typeof SETUP_TASK_READINESS_STATES)[number];
  actionableBy: (typeof SETUP_ACTIONABLE_BY)[number] | null;
  reasonCodes: string[];
  sourceRevision: string;
  freshness: (typeof SETUP_FACT_FRESHNESS)[number];
  evaluatedAt: string;
};

export type ProductEntryDecision = {
  requestedProduct: (typeof PRODUCT_ENTRY_PRODUCTS)[number];
  propertyId: string | null;
  decision: (typeof PRODUCT_ENTRY_DECISIONS)[number];
  destinationRouteKey: string | null;
  reasonCode: string | null;
};

/** The selected property's setup plan: the hotel-basics task the setup flow reads (VAY-2175). */
export type PropertySetupPlan = {
  propertyId: string;
  tasks: SetupTask[];
};

export type AdaptiveHotelSetupStatus = {
  contractVersion: typeof ADAPTIVE_HOTEL_SETUP_CONTRACT_VERSION;
  organization: {
    organizationId: string;
    displayName: string;
    websiteUrl: string | null;
    selectedTracks: SetupTrack[];
    trackRevision: number;
    canManageTracks: boolean;
    tracks: TrackStatus[];
  };
  propertySelection: {
    state: (typeof PROPERTY_SELECTION_STATES)[number];
    selectedPropertyId: string | null;
    availableProperties: Array<{
      propertyId: string;
      publicId: string;
      displayName: string | null;
      locationSummary: string | null;
    }>;
  };
  entryDecision: ProductEntryDecision | null;
  setupPlan: PropertySetupPlan | null;
  updatedAt: string;
};

const SETUP_TASK_TRACK: Record<SetupTaskId, SetupTask["track"]> = {
  shared_identity: "shared",
};

const MAX_EXPECTED_REVISION = 2_147_483_646;

export function isSetupTrack(value: unknown): value is SetupTrack {
  return typeof value === "string" && SETUP_TRACKS.includes(value as SetupTrack);
}

export function parseUpdateTracksRequest(value: unknown): UpdateTracksRequest | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["selectedTracks", "expectedRevision"])) return null;

  const selectedTracks = value["selectedTracks"];
  const expectedRevision = value["expectedRevision"];
  const materializedTracks = Array.isArray(selectedTracks) ? Array.from(selectedTracks) : null;
  if (
    materializedTracks === null ||
    materializedTracks.length === 0 ||
    !materializedTracks.every(isSetupTrack) ||
    new Set(materializedTracks).size !== materializedTracks.length ||
    !Number.isSafeInteger(expectedRevision) ||
    (expectedRevision as number) < 0 ||
    (expectedRevision as number) > MAX_EXPECTED_REVISION
  ) {
    return null;
  }

  return {
    selectedTracks: SETUP_TRACKS.filter((track) => materializedTracks.includes(track)),
    expectedRevision: expectedRevision as number,
  };
}

export function parseAdaptiveHotelSetupStatus(value: unknown): AdaptiveHotelSetupStatus | null {
  return isAdaptiveHotelSetupStatus(value) ? value : null;
}

function isAdaptiveHotelSetupStatus(value: unknown): value is AdaptiveHotelSetupStatus {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "contractVersion",
      "organization",
      "propertySelection",
      "entryDecision",
      "setupPlan",
      "updatedAt",
    ]) ||
    value["contractVersion"] !== ADAPTIVE_HOTEL_SETUP_CONTRACT_VERSION
  ) {
    return false;
  }
  const organization = value["organization"];
  const propertySelection = value["propertySelection"];
  const entryDecision = value["entryDecision"];
  const setupPlan = value["setupPlan"];
  if (
    !(
      isRecord(organization) &&
      hasOnlyKeys(organization, [
        "organizationId",
        "displayName",
        "websiteUrl",
        "selectedTracks",
        "trackRevision",
        "canManageTracks",
        "tracks",
      ]) &&
      isNonEmptyString(organization["organizationId"]) &&
      isNonEmptyString(organization["displayName"]) &&
      isNullableString(organization["websiteUrl"]) &&
      isArrayOf(organization["selectedTracks"], isSetupTrack) &&
      uniqueValues(organization["selectedTracks"]) &&
      isNonNegativeInteger(organization["trackRevision"]) &&
      typeof organization["canManageTracks"] === "boolean" &&
      isArrayOf(organization["tracks"], isTrackStatus) &&
      isPropertySelection(propertySelection) &&
      (entryDecision === null || isProductEntryDecision(entryDecision)) &&
      (setupPlan === null || isPropertySetupPlan(setupPlan, organization["selectedTracks"])) &&
      isIsoTimestamp(value["updatedAt"])
    )
  ) {
    return false;
  }

  const selectedTracks = organization["selectedTracks"];
  const tracks = organization["tracks"];
  const selectedPropertyId = propertySelection.selectedPropertyId;
  if (
    !sameOrder(
      selectedTracks,
      SETUP_TRACKS.filter((track) => selectedTracks.includes(track)),
    ) ||
    !sameOrder(
      tracks.map(({ track }) => track),
      SETUP_TRACKS,
    ) ||
    tracks.some(({ track, provisioning }) =>
      selectedTracks.includes(track)
        ? provisioning === "not_selected"
        : provisioning !== "not_selected",
    ) ||
    tracks.some(({ track, provisioning, components, allowedActions }) => {
      const selected = selectedTracks.includes(track);
      return (
        (provisioning === "active" && components.some(({ access }) => access !== "active")) ||
        !sameOrder(
          allowedActions,
          organization["canManageTracks"] ? (selected ? ["manage_service"] : ["add"]) : [],
        )
      );
    }) ||
    (entryDecision !== null && entryDecision.propertyId !== selectedPropertyId) ||
    (selectedPropertyId === null
      ? setupPlan !== null
      : setupPlan?.propertyId !== selectedPropertyId)
  ) {
    return false;
  }

  return true;
}

function isTrackStatus(value: unknown): value is TrackStatus {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["track", "provisioning", "components", "allowedActions"])
  ) {
    return false;
  }
  if (
    !(
      isSetupTrack(value["track"]) &&
      isOneOf(value["provisioning"], ["not_selected", "active", "blocked"]) &&
      isArrayOf(
        value["components"],
        (component): component is TrackStatus["components"][number] => {
          return (
            isRecord(component) &&
            hasOnlyKeys(component, ["product", "access"]) &&
            isOneOf(component["product"], ["pms", "booking"]) &&
            isOneOf(component["access"], ["absent", "active", "suspended", "unavailable"])
          );
        },
      ) &&
      isArrayOf(value["allowedActions"], (action) => isOneOf(action, ["add", "manage_service"])) &&
      uniqueValues(value["allowedActions"])
    )
  ) {
    return false;
  }
  return sameOrder(
    value["components"].map(({ product }) => product),
    SETUP_TRACK_COMPONENT_PRODUCTS[value["track"]],
  );
}

function isPropertySelection(
  value: unknown,
): value is AdaptiveHotelSetupStatus["propertySelection"] {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["state", "selectedPropertyId", "availableProperties"]) ||
    !isOneOf(value["state"], PROPERTY_SELECTION_STATES) ||
    !isNullableString(value["selectedPropertyId"]) ||
    !isArrayOf(
      value["availableProperties"],
      (
        property,
      ): property is AdaptiveHotelSetupStatus["propertySelection"]["availableProperties"][number] =>
        isRecord(property) &&
        hasOnlyKeys(property, ["propertyId", "publicId", "displayName", "locationSummary"]) &&
        isNonEmptyString(property["propertyId"]) &&
        isNonEmptyString(property["publicId"]) &&
        isNullableString(property["displayName"]) &&
        isNullableString(property["locationSummary"]),
    )
  ) {
    return false;
  }
  const ids = value["availableProperties"].map(({ propertyId }) => propertyId);
  if (!uniqueValues(ids)) return false;
  if (value["state"] === "no_property") {
    return ids.length === 0 && value["selectedPropertyId"] === null;
  }
  if (value["state"] === "single_property") {
    return ids.length === 1 && value["selectedPropertyId"] === ids[0];
  }
  return (
    ids.length > 1 &&
    (value["selectedPropertyId"] === null || ids.includes(value["selectedPropertyId"]))
  );
}

function isProductEntryDecision(value: unknown): value is ProductEntryDecision {
  if (
    !(
      isRecord(value) &&
      hasOnlyKeys(value, [
        "requestedProduct",
        "propertyId",
        "decision",
        "destinationRouteKey",
        "reasonCode",
      ]) &&
      isOneOf(value["requestedProduct"], PRODUCT_ENTRY_PRODUCTS) &&
      isNullableString(value["propertyId"]) &&
      isOneOf(value["decision"], PRODUCT_ENTRY_DECISIONS) &&
      isNullableString(value["destinationRouteKey"]) &&
      isNullableString(value["reasonCode"])
    )
  ) {
    return false;
  }
  if (value["decision"] === "enter") {
    return (
      isNonEmptyString(value["propertyId"]) &&
      value["destinationRouteKey"] === `${value["requestedProduct"]}.workspace` &&
      value["reasonCode"] === null
    );
  }
  if (value["decision"] === "setup_required") {
    return value["destinationRouteKey"] === "hotel_setup" && isNonEmptyString(value["reasonCode"]);
  }
  return (
    isNonEmptyString(value["propertyId"]) &&
    value["destinationRouteKey"] === null &&
    isNonEmptyString(value["reasonCode"])
  );
}

function isPropertySetupPlan(
  value: unknown,
  selectedTracks: SetupTrack[],
): value is PropertySetupPlan {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["propertyId", "tasks"]) ||
    !isNonEmptyString(value["propertyId"]) ||
    !isArrayOf(value["tasks"], isSetupTask)
  ) {
    return false;
  }
  const taskIds = value["tasks"].map(({ taskId }) => taskId);
  const expectedTaskIds = SETUP_TASK_IDS.filter(
    (taskId) =>
      (SETUP_TASK_TRACK[taskId] === "shared" && selectedTracks.length > 0) ||
      selectedTracks.includes(SETUP_TASK_TRACK[taskId] as SetupTrack),
  );
  return (
    uniqueValues(taskIds) &&
    taskIds.every((taskId) => expectedTaskIds.includes(taskId)) &&
    taskIds.includes("shared_identity") === expectedTaskIds.includes("shared_identity") &&
    value["tasks"].every(
      ({ taskId, propertyId, track }) =>
        propertyId === value["propertyId"] && track === SETUP_TASK_TRACK[taskId],
    )
  );
}

function isSetupTask(value: unknown): value is SetupTask {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "taskId",
      "propertyId",
      "track",
      "requirementOwnerDomain",
      "destinationRouteKey",
      "callerCapability",
      "ownerProgress",
      "readiness",
      "actionableBy",
      "reasonCodes",
      "sourceRevision",
      "freshness",
      "evaluatedAt",
    ]) &&
    isOneOf(value["taskId"], SETUP_TASK_IDS) &&
    isNonEmptyString(value["propertyId"]) &&
    isOneOf(value["track"], SETUP_TASK_TRACKS) &&
    isOneOf(value["requirementOwnerDomain"], SETUP_REQUIREMENT_OWNER_DOMAINS) &&
    value["destinationRouteKey"] === SETUP_TASK_DESTINATION_ROUTE_KEYS[value["taskId"]] &&
    isOneOf(value["callerCapability"], SETUP_CALLER_CAPABILITIES) &&
    isOneOf(value["ownerProgress"], SETUP_OWNER_PROGRESS_STATES) &&
    isOneOf(value["readiness"], SETUP_TASK_READINESS_STATES) &&
    (value["actionableBy"] === null || isOneOf(value["actionableBy"], SETUP_ACTIONABLE_BY)) &&
    isArrayOf(value["reasonCodes"], isNonEmptyString) &&
    uniqueValues(value["reasonCodes"]) &&
    isNonEmptyString(value["sourceRevision"]) &&
    isOneOf(value["freshness"], SETUP_FACT_FRESHNESS) &&
    isIsoTimestamp(value["evaluatedAt"]) &&
    (value["readiness"] !== "complete" || value["actionableBy"] === null) &&
    (value["freshness"] !== "stale" || value["readiness"] !== "complete") &&
    (value["readiness"] !== "actionable" || value["actionableBy"] !== null)
  );
}

function isArrayOf<T>(value: unknown, predicate: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && Array.from(value).every(predicate);
}

function uniqueValues(value: unknown): boolean {
  return Array.isArray(value) && new Set(value).size === value.length;
}

function sameOrder(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && options.includes(value as T);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
