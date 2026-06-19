import type { PermissionKey, ResourceType } from "@vayada/backend-auth";

import type { AskScope } from "./ask.js";

export type AskEvidenceToolId =
  | "get_booking_performance"
  | "get_booking_source_mix"
  | "get_conversion_funnel"
  | "get_setup_gaps"
  | "get_hotel_settings_summary";

export type AskEvidenceToolStatus =
  | "available"
  | "partial"
  | "unavailable"
  | "not_authorized"
  | "invalid_scope"
  | "error";

export type AskEvidenceToolScope = AskScope;

export type AskEvidenceEntry = {
  evidenceId: string;
  sourceOwner: string;
  sourceView: string;
  product: "booking" | "hotel_catalog" | "intelligence";
  resourceId: string;
  resourceType: ResourceType;
  metricKey: string;
  filters: Record<string, unknown>;
  freshness: { status: "fresh" | "stale" | "unknown" | "unavailable"; generatedAt?: string };
  quality: "complete" | "partial" | "stale" | "estimated" | "hotelier_entered" | "unavailable";
  sampleSize?: number;
  aggregateId?: string;
  valueSummary: Record<string, unknown>;
};

export type AskUnavailableData = {
  unavailableDataId: string;
  reason:
    | "missing_scope"
    | "not_linked_resource"
    | "missing_permission"
    | "missing_entitlement"
    | "inactive_entitlement"
    | "source_unavailable"
    | "stale_source"
    | "empty_result"
    | "source_not_in_catalog"
    | "external_data_needed"
    | "pii_restricted";
  sourceOwner?: string;
  requestedToolId: AskEvidenceToolId;
  canRetry: boolean;
  canClarify: boolean;
};

export type AskEvidenceToolResult = {
  toolCallId: string;
  toolId: AskEvidenceToolId;
  status: AskEvidenceToolStatus;
  inputScope: AskEvidenceToolScope;
  filters: Record<string, unknown>;
  evidence: AskEvidenceEntry[];
  unavailableData: AskUnavailableData[];
  audit: {
    requestId: string;
    actorInternalUserId: string;
    organizationId: string;
    resourceId?: string;
    permissionKeys: PermissionKey[];
  };
};

export type AskEvidenceRepository = {
  findMetricEvidence(input: {
    metricKeys: string[];
    resourceId: string;
    dateRange?: AskEvidenceToolScope["dateRange"];
    filters: Record<string, unknown>;
  }): Promise<AskEvidenceEntry[]>;
  findSetupEvidence(input: {
    resourceId: string;
    filters: Record<string, unknown>;
  }): Promise<AskEvidenceEntry[]>;
  close?(): Promise<void>;
};

export class AskEvidenceUnavailableError extends Error {
  readonly reason: AskUnavailableData["reason"];
  readonly status: AskEvidenceToolStatus;

  constructor(reason: AskUnavailableData["reason"], status: AskEvidenceToolStatus = "unavailable") {
    super(`Ask evidence unavailable: ${reason}`);
    this.name = "AskEvidenceUnavailableError";
    this.reason = reason;
    this.status = status;
  }
}
