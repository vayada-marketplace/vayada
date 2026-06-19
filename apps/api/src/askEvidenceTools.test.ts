import type { PermissionKey, RequestContext } from "@vayada/backend-auth";
import { describe, expect, it } from "vitest";

import {
  getBookingPerformance,
  getBookingSourceMix,
  getConversionFunnel,
  getHotelSettingsSummary,
  getSetupGaps,
  type AskEvidenceEntry,
  type AskEvidenceRepository,
  type AskEvidenceToolScope,
} from "./routes/askEvidenceTools.js";

const scope: AskEvidenceToolScope = {
  organizationId: "org_hotel_group",
  bookingHotelId: "booking_hotel_alpenrose",
  dateRange: { from: "2026-06-01", to: "2026-06-30" },
  locale: "en-US",
  currency: "EUR",
};

function context(
  permissions: PermissionKey[] = [
    "intelligence.ask.read",
    "booking.analytics.read",
    "booking.settings.read",
  ],
): RequestContext {
  return {
    actor: {
      internalUserId: "user_hotel_owner",
      providerIdentity: { provider: "workos", providerUserId: "workos_user" },
      email: "owner@example.com",
      status: "active",
    },
    selectedOrganization: {
      organizationId: "org_hotel_group",
      workosOrgId: "org_workos_hotel_group",
      kind: "hotel_group",
      status: "active",
    },
    membership: {
      membershipId: "membership_hotel_owner",
      status: "active",
      roleKey: "hotel_owner",
      workosRoleSlugs: ["hotel_owner"],
      permissions,
    },
    linkedResources: [
      {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: "booking_hotel_alpenrose",
        relationship: "owner",
        status: "active",
      },
      {
        product: "pms",
        resourceType: "pms_hotel",
        resourceId: "pms_hotel_alpenrose",
        relationship: "operator",
        status: "active",
      },
    ],
    entitlements: [],
    locale: "en-US",
    currency: "EUR",
    audit: { requestId: "req_ask_tools", source: "api", receivedAt: "2026-06-10T00:00:00Z" },
  };
}

const evidenceRows: AskEvidenceEntry[] = [
  evidence("booking.direct_booking_share", 48, { directSharePct: 62.5 }),
  evidence("booking.booking_source_mix", 48, {
    sourceBuckets: [{ source: "direct", bookingSharePct: 62.5 }],
  }),
  evidence("booking.gross_booking_revenue", 12, { grossBookingAmount: 18400, currency: "EUR" }),
  evidence("booking.average_daily_rate", 42, { averageDailyRate: 400, currency: "EUR" }),
  evidence(
    "hotel_catalog.setup_completeness_score",
    2,
    { completenessScore: 70 },
    "intelligence",
    "setup_completeness_snapshots",
    "partial",
  ),
];

function repository(rows = evidenceRows): AskEvidenceRepository {
  return {
    async findMetricEvidence({ metricKeys }) {
      return rows.filter((row) => metricKeys.includes(row.metricKey));
    },
    async findSetupEvidence() {
      return rows.filter((row) => row.metricKey === "hotel_catalog.setup_completeness_score");
    },
  };
}

function failingRepository(): AskEvidenceRepository {
  return {
    async findMetricEvidence() {
      throw new Error("metric source unavailable");
    },
    async findSetupEvidence() {
      throw new Error("setup source unavailable");
    },
  };
}

function evidence(
  metricKey: string,
  sampleSize: number,
  valueSummary: Record<string, unknown>,
  source = "booking",
  sourceView = "direct_booking_summary_read_model",
  quality: AskEvidenceEntry["quality"] = "complete",
  resourceId = "booking_hotel_alpenrose",
  resourceType: AskEvidenceEntry["resourceType"] = "booking_hotel",
): AskEvidenceEntry {
  return {
    evidenceId: `ev_${metricKey}`,
    sourceOwner: source,
    sourceView,
    product: source === "booking" ? "booking" : "intelligence",
    resourceId,
    resourceType,
    metricKey,
    filters: { dateRange: scope.dateRange, currency: "EUR" },
    freshness: { status: "fresh", generatedAt: "2026-06-09T08:30:00Z" },
    quality,
    sampleSize,
    aggregateId: `agg_${metricKey}`,
    valueSummary,
  };
}

describe("Ask Intelligence evidence tools", () => {
  it("returns booking performance evidence with freshness and sample sizes", async () => {
    const result = await getBookingPerformance(context(), repository(), scope);

    expect(result.status).toBe("available");
    expect(result.toolId).toBe("get_booking_performance");
    expect(result.evidence.map((row) => row.metricKey)).toEqual([
      "booking.direct_booking_share",
      "booking.gross_booking_revenue",
      "booking.average_daily_rate",
    ]);
    expect(result.evidence[0]).toMatchObject({
      sourceOwner: "booking",
      sourceView: "direct_booking_summary_read_model",
      resourceId: "booking_hotel_alpenrose",
      freshness: { status: "fresh" },
      quality: "complete",
      sampleSize: 48,
    });
  });

  it("returns source mix and setup summary through predefined read-only tools", async () => {
    const mix = await getBookingSourceMix(context(), repository(), scope);
    const settings = await getHotelSettingsSummary(context(), repository(), scope);

    expect(mix.status).toBe("available");
    expect(mix.evidence.map((row) => row.metricKey)).toEqual([
      "booking.booking_source_mix",
      "booking.direct_booking_share",
    ]);
    expect(settings.status).toBe("available");
    expect(settings.evidence[0]).toMatchObject({
      sourceOwner: "intelligence",
      sourceView: "setup_completeness_snapshots",
      metricKey: "hotel_catalog.setup_completeness_score",
      quality: "partial",
    });
  });

  it("passes authorized organization and requested tool ids to the repository", async () => {
    const calls: unknown[] = [];
    const capturingRepository: AskEvidenceRepository = {
      async findMetricEvidence(input) {
        calls.push(input);
        return [evidenceRows[0]];
      },
      async findSetupEvidence(input) {
        calls.push(input);
        return [evidenceRows[4]];
      },
    };

    await getBookingPerformance(context(), capturingRepository, scope, { currency: "EUR" });
    await getSetupGaps(context(), capturingRepository, scope);

    expect(calls).toEqual([
      expect.objectContaining({
        organizationId: "org_hotel_group",
        resourceId: "booking_hotel_alpenrose",
        filters: { currency: "EUR" },
      }),
      expect.objectContaining({
        toolId: "get_setup_gaps",
        organizationId: "org_hotel_group",
        resourceId: "booking_hotel_alpenrose",
      }),
    ]);
  });

  it("authorizes setup evidence through PMS read scope when booking settings read is absent", async () => {
    const result = await getSetupGaps(
      context(["intelligence.ask.read", "pms.read"]),
      repository(),
      { organizationId: "org_hotel_group", pmsHotelId: "pms_hotel_alpenrose" },
    );

    expect(result.status).toBe("available");
    expect(result.audit.permissionKeys).toContain("pms.read");
  });

  it("denies cross-tenant resource access without leaking evidence", async () => {
    const result = await getBookingPerformance(context(), repository(), {
      ...scope,
      bookingHotelId: "booking_hotel_bellevue",
    });

    expect(result.status).toBe("not_authorized");
    expect(result.evidence).toEqual([]);
    expect(result.unavailableData[0]).toMatchObject({
      reason: "not_linked_resource",
      requestedToolId: "get_booking_performance",
    });
  });

  it("returns missing-permission and missing-data states as typed unavailable data", async () => {
    const missingPermission = await getBookingPerformance(
      context(["intelligence.ask.read"]),
      repository(),
      scope,
      { source: "direct" },
    );
    const missingData = await getBookingPerformance(context(), repository([]), scope, {
      bookingStatus: "confirmed",
    });

    expect(missingPermission.status).toBe("not_authorized");
    expect(missingPermission.filters).toEqual({ source: "direct" });
    expect(missingPermission.unavailableData[0].reason).toBe("missing_permission");
    expect(missingData.status).toBe("unavailable");
    expect(missingData.filters).toEqual({ bookingStatus: "confirmed" });
    expect(missingData.unavailableData[0].reason).toBe("empty_result");
  });

  it("requires date range for booking metric tools", async () => {
    const result = await getBookingSourceMix(context(), repository(), {
      organizationId: "org_hotel_group",
      bookingHotelId: "booking_hotel_alpenrose",
    });

    expect(result.status).toBe("invalid_scope");
    expect(result.evidence).toEqual([]);
    expect(result.unavailableData[0].reason).toBe("missing_scope");
  });

  it("marks stale evidence as partial and conversion gaps as source unavailable", async () => {
    const stale = await getBookingPerformance(
      context(),
      repository([{ ...evidenceRows[0], freshness: { status: "stale" } }]),
      scope,
    );
    const funnel = await getConversionFunnel(context(), repository([]), scope);

    expect(stale.status).toBe("partial");
    expect(stale.unavailableData[0].reason).toBe("stale_source");
    expect(funnel.status).toBe("partial");
    expect(funnel.unavailableData[0].reason).toBe("source_unavailable");
  });

  it("maps repository failures to typed source-unavailable tool errors", async () => {
    const result = await getSetupGaps(context(), failingRepository(), scope);

    expect(result.status).toBe("error");
    expect(result.evidence).toEqual([]);
    expect(result.unavailableData[0].reason).toBe("source_unavailable");
  });
});
