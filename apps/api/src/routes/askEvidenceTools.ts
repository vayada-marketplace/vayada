import { hasActiveLinkedResource, hasPermission } from "@vayada/backend-authorization";
import type { PermissionKey, RequestContext } from "@vayada/backend-auth";
import {
  AskEvidenceUnavailableError,
  type AskEvidenceToolExecutor,
  type AskEvidenceToolExecutors,
  type AskEvidenceEntry,
  type AskEvidenceRepository,
  type AskEvidenceToolId,
  type AskEvidenceToolResult,
  type AskEvidenceToolScope,
  type AskEvidenceToolStatus,
  type AskUnavailableData,
} from "@vayada/domain-intelligence";

export type {
  AskEvidenceEntry,
  AskEvidenceToolExecutor,
  AskEvidenceToolExecutors,
  AskEvidenceRepository,
  AskEvidenceToolId,
  AskEvidenceToolResult,
  AskEvidenceToolScope,
  AskEvidenceToolStatus,
  AskUnavailableData,
} from "@vayada/domain-intelligence";

type ToolDefinition = {
  toolId: AskEvidenceToolId;
  permissionKeys: PermissionKey[];
  anyPermissionKeys?: PermissionKey[];
  resourceType: "booking_hotel" | "setup_hotel";
  requiresDateRange?: boolean;
  metricKeys: string[];
  sourceUnavailableReason?: AskUnavailableData["reason"];
};

const bookingPerformance: ToolDefinition = {
  toolId: "get_booking_performance",
  permissionKeys: ["intelligence.ask.read", "booking.analytics.read"],
  resourceType: "booking_hotel",
  requiresDateRange: true,
  metricKeys: [
    "booking.direct_booking_share",
    "booking.gross_booking_revenue",
    "booking.average_daily_rate",
  ],
};

const toolDefinitions = {
  get_booking_performance: bookingPerformance,
  get_booking_source_mix: {
    toolId: "get_booking_source_mix",
    permissionKeys: ["intelligence.ask.read", "booking.analytics.read"],
    resourceType: "booking_hotel",
    requiresDateRange: true,
    metricKeys: ["booking.booking_source_mix", "booking.direct_booking_share"],
  },
  get_conversion_funnel: {
    toolId: "get_conversion_funnel",
    permissionKeys: ["intelligence.ask.read", "booking.analytics.read"],
    resourceType: "booking_hotel",
    requiresDateRange: true,
    metricKeys: ["booking.conversion_funnel"],
    sourceUnavailableReason: "source_unavailable",
  },
  get_setup_gaps: {
    toolId: "get_setup_gaps",
    permissionKeys: ["intelligence.ask.read"],
    anyPermissionKeys: ["booking.settings.read", "pms.read"],
    resourceType: "setup_hotel",
    metricKeys: ["hotel_catalog.setup_completeness_score"],
  },
  get_hotel_settings_summary: {
    toolId: "get_hotel_settings_summary",
    permissionKeys: ["intelligence.ask.read"],
    anyPermissionKeys: ["booking.settings.read", "pms.read"],
    resourceType: "setup_hotel",
    metricKeys: ["hotel_catalog.setup_completeness_score"],
  },
} as const satisfies Record<AskEvidenceToolId, ToolDefinition>;

export function createAskEvidenceToolExecutors(
  repository: AskEvidenceRepository,
): AskEvidenceToolExecutors {
  return {
    get_booking_performance: (context, scope, filters) =>
      getBookingPerformance(context, repository, scope, filters),
    get_booking_source_mix: (context, scope, filters) =>
      getBookingSourceMix(context, repository, scope, filters),
    get_conversion_funnel: (context, scope, filters) =>
      getConversionFunnel(context, repository, scope, filters),
    get_setup_gaps: (context, scope, filters) => getSetupGaps(context, repository, scope, filters),
    get_hotel_settings_summary: (context, scope, filters) =>
      getHotelSettingsSummary(context, repository, scope, filters),
  };
}

export async function getBookingPerformance(
  context: RequestContext,
  repository: AskEvidenceRepository,
  scope: AskEvidenceToolScope,
  filters: Record<string, unknown> = {},
): Promise<AskEvidenceToolResult> {
  return metricTool(context, repository, toolDefinitions.get_booking_performance, scope, filters);
}

export async function getBookingSourceMix(
  context: RequestContext,
  repository: AskEvidenceRepository,
  scope: AskEvidenceToolScope,
  filters: Record<string, unknown> = {},
): Promise<AskEvidenceToolResult> {
  return metricTool(context, repository, toolDefinitions.get_booking_source_mix, scope, filters);
}

export async function getConversionFunnel(
  context: RequestContext,
  repository: AskEvidenceRepository,
  scope: AskEvidenceToolScope,
  filters: Record<string, unknown> = {},
): Promise<AskEvidenceToolResult> {
  return metricTool(context, repository, toolDefinitions.get_conversion_funnel, scope, filters);
}

export async function getSetupGaps(
  context: RequestContext,
  repository: AskEvidenceRepository,
  scope: AskEvidenceToolScope,
  filters: Record<string, unknown> = {},
): Promise<AskEvidenceToolResult> {
  return setupTool(context, repository, toolDefinitions.get_setup_gaps, scope, filters);
}

export async function getHotelSettingsSummary(
  context: RequestContext,
  repository: AskEvidenceRepository,
  scope: AskEvidenceToolScope,
  filters: Record<string, unknown> = {},
): Promise<AskEvidenceToolResult> {
  return setupTool(context, repository, toolDefinitions.get_hotel_settings_summary, scope, filters);
}

async function metricTool(
  context: RequestContext,
  repository: AskEvidenceRepository,
  definition: ToolDefinition,
  scope: AskEvidenceToolScope,
  filters: Record<string, unknown>,
): Promise<AskEvidenceToolResult> {
  const authorized = authorize(context, definition, scope, filters);
  if (authorized) return authorized;

  try {
    const evidence = await repository.findMetricEvidence({
      metricKeys: definition.metricKeys,
      organizationId: scope.organizationId!,
      resourceId: scope.bookingHotelId!,
      dateRange: scope.dateRange,
      filters,
    });
    return toEvidenceResult(
      context,
      definition,
      scope,
      filters,
      orderEvidence(definition, evidence),
    );
  } catch (error) {
    if (error instanceof AskEvidenceUnavailableError) {
      return unavailableResult(context, definition, scope, filters, error.status, error.reason);
    }
    return unavailableResult(context, definition, scope, filters, "error", "source_unavailable");
  }
}

async function setupTool(
  context: RequestContext,
  repository: AskEvidenceRepository,
  definition: ToolDefinition,
  scope: AskEvidenceToolScope,
  filters: Record<string, unknown>,
): Promise<AskEvidenceToolResult> {
  const authorized = authorize(context, definition, scope, filters);
  if (authorized) return authorized;

  try {
    const resource = setupResource(scope);
    const evidence = await repository.findSetupEvidence({
      toolId: definition.toolId,
      organizationId: scope.organizationId!,
      resourceId: resource.resourceId!,
      filters,
    });
    return toEvidenceResult(context, definition, scope, filters, evidence);
  } catch (error) {
    if (error instanceof AskEvidenceUnavailableError) {
      return unavailableResult(context, definition, scope, filters, error.status, error.reason);
    }
    return unavailableResult(context, definition, scope, filters, "error", "source_unavailable");
  }
}

function authorize(
  context: RequestContext,
  definition: ToolDefinition,
  scope: AskEvidenceToolScope,
  filters: Record<string, unknown>,
): AskEvidenceToolResult | null {
  const resource =
    definition.resourceType === "setup_hotel" ? setupResource(scope) : bookingResource(scope);
  if (!scope.organizationId || !resource.resourceId) {
    return unavailableResult(context, definition, scope, filters, "invalid_scope", "missing_scope");
  }
  if (definition.requiresDateRange && !scope.dateRange) {
    return unavailableResult(context, definition, scope, filters, "invalid_scope", "missing_scope");
  }

  const missingPermission = definition.permissionKeys.find((key) => !hasPermission(context, key));
  if (missingPermission) {
    return unavailableResult(
      context,
      definition,
      scope,
      filters,
      "not_authorized",
      "missing_permission",
    );
  }
  if (
    definition.anyPermissionKeys &&
    !definition.anyPermissionKeys.some((key) => hasPermission(context, key))
  ) {
    return unavailableResult(
      context,
      definition,
      scope,
      filters,
      "not_authorized",
      "missing_permission",
    );
  }

  const hasResource = hasActiveLinkedResource(context, {
    product: resource.product,
    resourceType: resource.resourceType,
    resourceId: resource.resourceId,
    allowedRelationships: ["owner", "operator"],
  });
  if (scope.organizationId !== context.selectedOrganization.organizationId || !hasResource) {
    return unavailableResult(
      context,
      definition,
      scope,
      filters,
      "not_authorized",
      "not_linked_resource",
    );
  }

  return null;
}

function toEvidenceResult(
  context: RequestContext,
  definition: ToolDefinition,
  scope: AskEvidenceToolScope,
  filters: Record<string, unknown>,
  evidence: AskEvidenceEntry[],
): AskEvidenceToolResult {
  if (evidence.length === 0) {
    return unavailableResult(
      context,
      definition,
      scope,
      filters,
      definition.sourceUnavailableReason ? "partial" : "unavailable",
      definition.sourceUnavailableReason ?? "empty_result",
    );
  }

  const stale = evidence.some(
    (item) => item.freshness.status === "stale" || item.quality === "stale",
  );
  return {
    ...baseResult(context, definition, scope, filters),
    status: stale ? "partial" : "available",
    evidence,
    unavailableData: stale ? [unavailable(definition.toolId, "stale_source")] : [],
  };
}

function unavailableResult(
  context: RequestContext,
  definition: ToolDefinition,
  scope: AskEvidenceToolScope,
  filters: Record<string, unknown>,
  status: AskEvidenceToolStatus,
  reason: AskUnavailableData["reason"],
): AskEvidenceToolResult {
  return {
    ...baseResult(context, definition, scope, filters),
    status,
    evidence: [],
    unavailableData: [unavailable(definition.toolId, reason)],
  };
}

function orderEvidence(definition: ToolDefinition, evidence: AskEvidenceEntry[]) {
  const metricOrder = new Map(definition.metricKeys.map((metricKey, index) => [metricKey, index]));
  return [...evidence].sort(
    (left, right) =>
      (metricOrder.get(left.metricKey) ?? Number.MAX_SAFE_INTEGER) -
      (metricOrder.get(right.metricKey) ?? Number.MAX_SAFE_INTEGER),
  );
}

function baseResult(
  context: RequestContext,
  definition: ToolDefinition,
  scope: AskEvidenceToolScope,
  filters: Record<string, unknown>,
): Omit<AskEvidenceToolResult, "status" | "evidence" | "unavailableData"> {
  return {
    toolCallId: `${definition.toolId}_${context.audit.requestId}`,
    toolId: definition.toolId,
    inputScope: scope,
    filters,
    audit: {
      requestId: context.audit.requestId,
      actorInternalUserId: context.actor.internalUserId,
      organizationId: context.selectedOrganization.organizationId,
      resourceId: setupResource(scope).resourceId || scope.bookingHotelId,
      permissionKeys: [...definition.permissionKeys, ...(definition.anyPermissionKeys ?? [])],
    },
  };
}

function bookingResource(scope: AskEvidenceToolScope) {
  return {
    product: "booking" as const,
    resourceType: "booking_hotel" as const,
    resourceId: scope.bookingHotelId,
  };
}

function setupResource(scope: AskEvidenceToolScope) {
  return scope.bookingHotelId
    ? bookingResource(scope)
    : { product: "pms" as const, resourceType: "pms_hotel" as const, resourceId: scope.pmsHotelId };
}

function unavailable(
  requestedToolId: AskEvidenceToolId,
  reason: AskUnavailableData["reason"],
): AskUnavailableData {
  return {
    unavailableDataId: `${requestedToolId}_${reason}`,
    reason,
    requestedToolId,
    canRetry: reason === "source_unavailable" || reason === "stale_source",
    canClarify: reason === "missing_scope" || reason === "not_linked_resource",
  };
}
