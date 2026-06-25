import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type ProductEntitlement,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import { AskEvidenceUnavailableError } from "@vayada/domain-intelligence";
import { Usage, type Model, type ModelRequest, type ModelResponse } from "@openai/agents";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";

import { buildApp } from "./app.js";
import {
  createTargetAskEvidenceRepository,
  type AskEvidenceReadPool,
} from "./platform/askEvidenceRepository.js";
import {
  createInMemoryAskAuditRepository,
  type AskAnswer,
  type AskAuditRecord,
  type AskAuditRepository,
  type AskRoutesOptions,
} from "./routes/ask.js";

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
const askOwnerPermissions: PermissionKey[] = [
  "intelligence.ask.read",
  "booking.analytics.read",
  "booking.settings.read",
];

const session: VerifiedSession = {
  workosUserId: "user_workos_hotel_owner",
  workosOrgId: "org_workos_hotel_group",
  sessionId: "session_hotel_owner",
  expiresAt: futureExpiry,
};

const identityRepository: IdentityRepository = {
  async findUserByProviderUserId() {
    return {
      userId: "user_hotel_owner",
      email: "owner@example.com",
      status: "active",
    };
  },
  async findOrganizationByWorkosOrgId() {
    return {
      organizationId: "org_hotel_group",
      workosOrgId: "org_workos_hotel_group",
      kind: "hotel_group",
      status: "active",
    };
  },
  async findActiveMembership() {
    return {
      membershipId: "membership_hotel_owner",
      status: "active",
      roleKey: "hotel_owner",
      workosMembershipId: "om_hotel_owner",
      workosRoleSlugs: ["hotel_owner"],
    };
  },
  async findLinkedResources() {
    return [
      {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: "booking_hotel_alpenrose",
        relationship: "owner",
        status: "active",
      },
    ];
  },
};

type AskAuditTestRepository = AskAuditRepository & {
  records: AskAuditRecord[];
};

function buildAskApp(
  options: {
    permissions?: PermissionKey[];
    entitlements?: ProductEntitlement[];
    auditRepository?: AskAuditTestRepository;
    askModel?: Model;
    askBudgets?: AskRoutesOptions["budgets"];
    roleKey?: string;
    resourceRelationship?: "owner" | "operator";
    askEvidenceRepository?: AskRoutesOptions["evidenceRepository"];
  } = {},
): ReturnType<typeof buildApp> {
  return buildApp({
    logger: false,
    askAuditRepository: options.auditRepository ?? createInMemoryAskAuditRepository(),
    askModel: options.askModel,
    askBudgets: options.askBudgets,
    askEvidenceRepository: options.askEvidenceRepository,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: {
        ...identityRepository,
        async findActiveMembership(...args) {
          const membership = await identityRepository.findActiveMembership(...args);
          if (!membership) return null;
          return {
            ...membership,
            roleKey: options.roleKey ?? membership.roleKey,
            workosRoleSlugs: [options.roleKey ?? membership.roleKey],
          };
        },
        async findLinkedResources(...args) {
          const resources = await identityRepository.findLinkedResources(...args);
          return resources.map((resource) =>
            resource.product === "booking" && resource.resourceType === "booking_hotel"
              ? { ...resource, relationship: options.resourceRelationship ?? resource.relationship }
              : resource,
          );
        },
      },
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return (
            options.permissions ?? [
              "intelligence.ask.read",
              "booking.analytics.read",
              "booking.settings.read",
            ]
          );
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return (
            options.entitlements ?? [
              {
                product: "booking",
                key: "booking-engine",
                status: "active",
              },
            ]
          );
        },
      },
    },
  });
}

class RepeatingToolCallModel implements Model {
  readonly requests: ModelRequest[] = [];

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      output: [
        {
          type: "function_call",
          callId: `call_loop_${this.requests.length}`,
          name: "get_booking_performance",
          arguments: JSON.stringify({ filters: {} }),
          status: "completed",
        },
      ],
    };
  }

  async *getStreamedResponse() {
    throw new Error("Streaming is not used in Ask route tests");
  }
}

function askPayload(overrides: Partial<Record<"question" | "scope", unknown>> = {}) {
  return {
    question: "Why did my direct booking share change this month?",
    scope: {
      organizationId: "org_hotel_group",
      bookingHotelId: "booking_hotel_alpenrose",
      dateRange: {
        from: "2026-06-01",
        to: "2026-06-30",
      },
      locale: "en-US",
      currency: "EUR",
    },
    ...overrides,
  };
}

type TargetAskEvidencePool = AskEvidenceReadPool & {
  calls: { text: string; values?: readonly unknown[] }[];
};

function targetAskEvidencePool(
  options: {
    metricRows?: QueryResultRow[];
    setupRows?: QueryResultRow[];
    fail?: boolean;
    missingCatalog?: boolean;
    missingCatalogToolIds?: string[];
  } = {},
): TargetAskEvidencePool {
  const calls: TargetAskEvidencePool["calls"] = [];
  const metricRows = options.metricRows ?? targetMetricRows();
  const setupRows = options.setupRows ?? targetSetupRows();

  return {
    calls,
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ) {
      calls.push({ text, values });
      if (options.fail) throw new Error("target ask evidence unavailable");
      if (text.includes("intelligence.metric_snapshot_runs")) {
        const metricKeys = Array.isArray(values?.[0]) ? values[0] : [];
        return queryRows<T>(
          metricRows.filter((row) => metricKeys.includes(String(row["metricKey"]))),
        );
      }
      if (text.includes("intelligence.setup_completeness_snapshots")) {
        return queryRows<T>(setupRows);
      }
      if (text.includes("intelligence.ai_evidence_catalog")) {
        const requestedToolIds = Array.isArray(values?.[0])
          ? values[0].map((value) => String(value))
          : typeof values?.[0] === "string"
            ? [values[0]]
            : [];
        const missingRequestedTool = requestedToolIds.some((toolId) =>
          options.missingCatalogToolIds?.includes(toolId),
        );
        return queryRows<T>(
          options.missingCatalog || missingRequestedTool ? [] : [{ active: true }],
        );
      }
      return queryRows<T>([]);
    },
    async end() {},
  };
}

function queryRows<T extends QueryResultRow>(items: QueryResultRow[]): { rows: T[] } {
  return { rows: items as T[] };
}

function targetAskEvidenceRepository(pool: AskEvidenceReadPool) {
  return createTargetAskEvidenceRepository({
    connectionString: "postgresql://target-db",
    pool,
  });
}

function targetMetricRows(
  overrides: Partial<{
    directShareFreshnessStatus: string;
    directShareQuality: string;
  }> = {},
): QueryResultRow[] {
  return [
    targetMetricRow({
      id: "target_direct_share",
      snapshotKey: "intelligence.booking_direct_share.target.2026_06",
      metricKey: "booking.direct_booking_share",
      freshnessStatus: overrides.directShareFreshnessStatus ?? "fresh",
      quality: overrides.directShareQuality ?? "complete",
      sampleSize: 48,
      aggregateId: "booking-direct-share-target-june",
      valueSummary: {
        directSharePct: 64.2,
        previousDirectSharePct: 58.1,
        includedBookingCount: 48,
      },
      filters: { dateRange: "2026-06", channels: ["direct", "partner"] },
    }),
    targetMetricRow({
      id: "target_gross_revenue",
      snapshotKey: "intelligence.booking_gross_revenue.target.2026_06",
      metricKey: "booking.gross_booking_revenue",
      sampleSize: 48,
      aggregateId: "booking-gross-revenue-target-june",
      valueSummary: { grossRevenue: 21950, currency: "EUR" },
      filters: { dateRange: "2026-06", currency: "EUR" },
    }),
    targetMetricRow({
      id: "target_adr",
      snapshotKey: "intelligence.booking_adr.target.2026_06",
      metricKey: "booking.average_daily_rate",
      sampleSize: 42,
      aggregateId: "booking-adr-target-june",
      valueSummary: { averageDailyRate: 157, currency: "EUR" },
      filters: { dateRange: "2026-06", currency: "EUR" },
    }),
    targetMetricRow({
      id: "target_source_mix",
      snapshotKey: "intelligence.booking_source_mix.target.2026_06",
      metricKey: "booking.booking_source_mix",
      sampleSize: 48,
      aggregateId: "booking-source-mix-target-june",
      valueSummary: {
        topSource: "direct",
        directBookings: 31,
        otaBookings: 17,
      },
      filters: { dateRange: "2026-06", channels: ["direct", "ota"] },
    }),
  ];
}

function targetMetricRow(overrides: QueryResultRow): QueryResultRow {
  return {
    sourceOwner: "booking",
    sourceView: "direct_booking_summary_read_model",
    product: "booking",
    requestedResourceId: "booking_hotel_alpenrose",
    resourceType: "booking_hotel",
    generatedAt: "2026-06-09T08:30:00Z",
    sourceFreshAt: "2026-06-09T08:25:00Z",
    freshnessStatus: "fresh",
    quality: "complete",
    ...overrides,
  };
}

function targetSetupRows(): QueryResultRow[] {
  return [
    {
      id: "target_setup_overall",
      snapshotKey: "intelligence.setup_overall.target.2026_06_09",
      requestedResourceId: "booking_hotel_alpenrose",
      resourceType: "booking_hotel",
      setupArea: "overall",
      completionStatus: "complete",
      completenessScore: "100.00",
      sourceSnapshotAt: "2026-06-09T08:40:00Z",
      sourceFreshAt: "2026-06-09T08:38:00Z",
      freshnessStatus: "fresh",
      missingItems: [],
      blockingItems: [],
      staleItems: [],
      sourceFreshness: { hotel_catalog: { status: "fresh" } },
    },
    {
      id: "target_setup_payment",
      snapshotKey: "intelligence.setup_payment.target.2026_06_09",
      requestedResourceId: "booking_hotel_alpenrose",
      resourceType: "booking_hotel",
      setupArea: "payment",
      completionStatus: "incomplete",
      completenessScore: "70.00",
      sourceSnapshotAt: "2026-06-09T08:40:00Z",
      sourceFreshAt: "2026-06-09T08:38:00Z",
      freshnessStatus: "fresh",
      missingItems: [{ itemKey: "deposit_policy", label: "Deposit policy needs confirmation" }],
      blockingItems: [{ itemKey: "online_payment", label: "Online payment activation is pending" }],
      staleItems: [],
      sourceFreshness: { booking: { status: "fresh" } },
    },
  ];
}

function expectValidAskAnswerEnvelope(answer: AskAnswer): void {
  expect(answer.contractVersion).toBe("ask-intelligence-evidence.v1");
  expect(answer.answerId).toBeTruthy();
  expect(answer.generatedAt).toBeTruthy();
  expect(answer.conversationId).toBeTruthy();
  expect(answer.runId).toBeTruthy();
  expect(typeof answer.question).toBe("string");
  expect(answer.scope).toBeTruthy();
  expect([
    "answered",
    "partial",
    "needs_clarification",
    "unavailable",
    "external_data_needed",
    "not_authorized",
  ]).toContain(answer.status);
  expect(typeof answer.summary).toBe("string");
  expect(Array.isArray(answer.blocks)).toBe(true);
  expect(Array.isArray(answer.evidenceReferences)).toBe(true);
  expect(Array.isArray(answer.unavailableData)).toBe(true);
  expect(Array.isArray(answer.caveats)).toBe(true);
  expect(["high", "medium", "low", "unknown"]).toContain(answer.confidence.level);
  expect(Array.isArray(answer.confidence.reasons)).toBe(true);
  expect(Array.isArray(answer.suggestedActions)).toBe(true);
  expect(Array.isArray(answer.followUpQuestions)).toBe(true);
  expect(answer.audit.requestId).toBeTruthy();
  expect(Array.isArray(answer.audit.toolCallIds)).toBe(true);
  expect(Array.isArray(answer.audit.deniedToolCallIds)).toBe(true);
}

function askRoleGrantSeedSql(): string {
  const workspaceRelative = resolve(
    process.cwd(),
    "../../packages/backend-migration/migrations/0019_seed_ask_intelligence_role_grants.sql",
  );
  const path = existsSync(workspaceRelative)
    ? workspaceRelative
    : resolve(
        process.cwd(),
        "packages/backend-migration/migrations/0019_seed_ask_intelligence_role_grants.sql",
      );
  return readFileSync(path, "utf8");
}

function expectAskOwnerSeedGrants(roleKey: "hotel_owner" | "owner" | "operator"): void {
  const sql = askRoleGrantSeedSql().replace(/\s+/g, " ");
  for (const permission of askOwnerPermissions) {
    expect(sql).toContain(`('hotel_group', '${roleKey}', '${permission}')`);
  }
}

type EvidenceContractFixtureAnswer = Pick<
  AskAnswer,
  | "status"
  | "summary"
  | "blocks"
  | "evidenceReferences"
  | "unavailableData"
  | "confidence"
  | "audit"
>;

function loadEvidenceFixtureAnswers(): EvidenceContractFixtureAnswer[] {
  const path = resolve(
    process.cwd(),
    "../../engineering/fixtures/ask-intelligence-evidence/answers.json",
  );
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    cases: { answer: EvidenceContractFixtureAnswer }[];
  };
  return parsed.cases.map((fixture) => fixture.answer);
}

function expectEvidenceFixtureAnswerShape(answer: EvidenceContractFixtureAnswer): void {
  expect([
    "answered",
    "partial",
    "needs_clarification",
    "unavailable",
    "external_data_needed",
    "not_authorized",
  ]).toContain(answer.status);
  expect(typeof answer.summary).toBe("string");
  expect(Array.isArray(answer.blocks)).toBe(true);
  expect(Array.isArray(answer.evidenceReferences)).toBe(true);
  expect(Array.isArray(answer.unavailableData)).toBe(true);
  expect(["high", "medium", "low", "unknown"]).toContain(answer.confidence.level);
  expect(Array.isArray(answer.confidence.reasons)).toBe(true);
  expect(Array.isArray(answer.audit.toolCallIds)).toBe(true);
  expect(Array.isArray(answer.audit.deniedToolCallIds)).toBe(true);
}

describe("Ask Intelligence route", () => {
  let app: ReturnType<typeof buildApp> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("queries target evidence by selected organization and exact metric filters", async () => {
    const targetPool = targetAskEvidencePool({ metricRows: [], setupRows: [] });
    const repository = targetAskEvidenceRepository(targetPool);

    await repository.findMetricEvidence({
      metricKeys: ["booking.direct_booking_share"],
      organizationId: "org_hotel_group",
      resourceId: "booking_hotel_alpenrose",
      dateRange: { from: "2026-06-01", to: "2026-06-30" },
      filters: { currency: "EUR" },
    });

    const metricCall = targetPool.calls.find((call) =>
      call.text.includes("intelligence.metric_snapshot_runs"),
    );

    expect(metricCall?.values).toEqual([
      ["booking.direct_booking_share"],
      "booking_hotel_alpenrose",
      "org_hotel_group",
      "2026-06-01",
      "2026-06-30",
      ["get_booking_performance"],
      JSON.stringify({ currency: "EUR" }),
    ]);
    expect(metricCall?.text).toContain("snapshot.organization_id = $3::uuid");
    expect(metricCall?.text).toContain("snapshot.period_start = $4::date");
    expect(metricCall?.text).toContain("snapshot.period_end = $5::date");
    expect(metricCall?.text).toContain("snapshot.filters @> $7::jsonb");
    expect(metricCall?.text).toContain("expires_at <= now()");
    expect(metricCall?.text).toContain("freshness_slo_seconds");
  });

  it("checks target setup evidence catalog entries per requested tool", async () => {
    const targetPool = targetAskEvidencePool({
      missingCatalogToolIds: ["get_setup_gaps"],
    });
    const repository = targetAskEvidenceRepository(targetPool);

    await expect(
      repository.findSetupEvidence({
        toolId: "get_setup_gaps",
        organizationId: "org_hotel_group",
        resourceId: "booking_hotel_alpenrose",
        filters: {},
      }),
    ).rejects.toBeInstanceOf(AskEvidenceUnavailableError);
    await expect(
      repository.findSetupEvidence({
        toolId: "get_hotel_settings_summary",
        organizationId: "org_hotel_group",
        resourceId: "booking_hotel_alpenrose",
        filters: {},
      }),
    ).resolves.toHaveLength(2);

    const setupCall = targetPool.calls.find((call) =>
      call.text.includes("intelligence.setup_completeness_snapshots"),
    );

    expect(setupCall?.values).toEqual([
      "booking_hotel_alpenrose",
      "org_hotel_group",
      "get_hotel_settings_summary",
    ]);
    expect(setupCall?.text).toContain("setup.organization_id = $2::uuid");
    expect(setupCall?.text).toContain("catalog.tool_id = $3::text");
    expect(setupCall?.text).toContain("freshness_slo_seconds");
  });

  it("returns an answered AskAnswer envelope for fixture-backed booking performance", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    app = buildAskApp({ auditRepository });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload(),
    });

    expect(response.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("answered");
    expect(response.body.evidenceReferences[0]).toMatchObject({
      toolId: "get_booking_performance",
      metricKey: "booking.direct_booking_share",
      sourceView: "direct_booking_summary_read_model",
    });
    expect(response.body.audit.toolCallIds).toEqual([
      "ask_tool_call_1_get_booking_performance",
      "ask_tool_call_2_get_booking_source_mix",
    ]);
    expect(auditRepository.records).toMatchObject([
      {
        actorInternalUserId: "user_hotel_owner",
        organizationId: "org_hotel_group",
        bookingHotelId: "booking_hotel_alpenrose",
        status: "answered",
        toolCallIds: [
          "ask_tool_call_1_get_booking_performance",
          "ask_tool_call_2_get_booking_source_mix",
        ],
        evidenceIds: expect.arrayContaining(["ev_booking_direct_share", "ev_booking_source_mix"]),
        modelProvider: "fixture",
        modelName: "deterministic-ask-route-fixture.v1",
        promptVersion: "ask-prompt.v1",
        answerSchemaVersion: "ask-answer-schema.v1",
        latencyMs: expect.any(Number),
        usage: { requests: 2, inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        estimatedCostUsd: null,
      },
    ]);
    expect(auditRepository.records[0].modelResponseIds).toHaveLength(2);
    expect(auditRepository.records[0].modelRequestIds).toHaveLength(2);
    expect(auditRepository.records[0].traceId).toBe(
      `ask_trace_ask_run_${response.body.audit.requestId}`,
    );
  });

  it("allows seeded hotel owner grants to call Ask for a linked booking hotel", async () => {
    expectAskOwnerSeedGrants("hotel_owner");
    expectAskOwnerSeedGrants("owner");
    app = buildAskApp({ permissions: askOwnerPermissions });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload(),
    });

    expect(response.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("answered");
    expect(response.body.scope.bookingHotelId).toBe("booking_hotel_alpenrose");
    expect(response.body.evidenceReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolId: "get_booking_performance",
          metricKey: "booking.direct_booking_share",
        }),
      ]),
    );
  });

  it("allows seeded hotel operator grants to call Ask for an operator-linked booking hotel", async () => {
    expectAskOwnerSeedGrants("operator");
    app = buildAskApp({
      permissions: askOwnerPermissions,
      roleKey: "operator",
      resourceRelationship: "operator",
    });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload(),
    });

    expect(response.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("answered");
    expect(response.body.scope.bookingHotelId).toBe("booking_hotel_alpenrose");
  });

  it("returns the answer when audit persistence fails", async () => {
    const auditRepository: AskAuditTestRepository = {
      records: [],
      async recordAskRun() {
        throw new Error("audit database unavailable");
      },
    };
    app = buildAskApp({ auditRepository });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload(),
    });

    expect(response.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("answered");
  });

  it("closes the audit repository during Fastify shutdown", async () => {
    let closed = false;
    const auditRepository: AskAuditTestRepository = {
      records: [],
      async recordAskRun(record) {
        this.records.push(record);
      },
      async close() {
        closed = true;
      },
    };
    app = buildAskApp({ auditRepository });
    await app.ready();

    await app.close();
    app = null;

    expect(closed).toBe(true);
  });

  it("answers booking source mix through the runtime evidence tool plan", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    app = buildAskApp({ auditRepository });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload({ question: "Which booking source generated the most revenue?" }),
    });

    expect(response.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("answered");
    expect(response.body.evidenceReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolId: "get_booking_source_mix",
          metricKey: "booking.booking_source_mix",
        }),
      ]),
    );
    expect(auditRepository.records[0]).toMatchObject({
      status: "answered",
      toolCallIds: expect.arrayContaining(["ask_tool_call_1_get_booking_source_mix"]),
      evidenceIds: expect.arrayContaining(["ev_booking_source_mix"]),
    });
  });

  it("returns partial setup completeness fixture answers", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    app = buildAskApp({ auditRepository });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload({ question: "What setup gaps should I fix?" }),
    });

    expect(response.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("partial");
    expect(response.body.blocks[0]).toMatchObject({
      type: "setup_gap",
      metricKey: "hotel_catalog.setup_completeness_score",
    });
    expect(response.body.evidenceReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceId: "ev_setup_payment_gap",
          toolId: "get_setup_gaps",
          metricKey: "hotel_catalog.setup_completeness_score",
        }),
      ]),
    );
    expect(auditRepository.records[0]).toMatchObject({
      status: "partial",
      toolCallIds: expect.arrayContaining(["ask_tool_call_1_get_setup_gaps"]),
      evidenceIds: expect.arrayContaining(["ev_setup_payment_gap"]),
    });
  });

  it("answers from target evidence rows when the target repository is configured", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    const targetPool = targetAskEvidencePool();
    app = buildAskApp({
      auditRepository,
      askEvidenceRepository: targetAskEvidenceRepository(targetPool),
    });

    const performance = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload(),
    });

    expect(performance.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(performance.body);
    expect(performance.body.status).toBe("answered");
    expect(performance.body.evidenceReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceId: "metric_target_direct_share",
          toolId: "get_booking_performance",
          sourceView: "direct_booking_summary_read_model",
          metricKey: "booking.direct_booking_share",
          aggregateId: "booking-direct-share-target-june",
        }),
        expect.objectContaining({
          evidenceId: "metric_target_source_mix",
          toolId: "get_booking_source_mix",
          metricKey: "booking.booking_source_mix",
        }),
      ]),
    );

    const setup = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload({ question: "What setup gaps should I fix?" }),
    });

    expect(setup.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(setup.body);
    expect(setup.body.status).toBe("partial");
    expect(setup.body.evidenceReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceId: "setup_target_setup_payment",
          sourceOwner: "intelligence",
          sourceView: "setup_completeness_snapshots",
          metricKey: "hotel_catalog.setup_completeness_score",
          quality: "partial",
        }),
      ]),
    );
    expect(
      targetPool.calls.some((call) => call.text.includes("intelligence.ai_evidence_catalog")),
    ).toBe(true);
    expect(targetPool.calls.some((call) => /FROM\s+booking_hotels\b/i.test(call.text))).toBe(false);
  });

  it("returns structured unavailable data when target evidence rows are empty", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    app = buildAskApp({
      auditRepository,
      askEvidenceRepository: targetAskEvidenceRepository(
        targetAskEvidencePool({ metricRows: [], setupRows: [] }),
      ),
    });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload(),
    });

    expect(response.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("unavailable");
    expect(response.body.evidenceReferences).toEqual([]);
    expect(response.body.unavailableData).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "empty_result",
          requestedToolId: "get_booking_performance",
        }),
      ]),
    );
    expect(auditRepository.records[0]).toMatchObject({
      status: "unavailable",
      evidenceIds: [],
    });
  });

  it("returns source-not-in-catalog when target catalog rows are missing", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    app = buildAskApp({
      auditRepository,
      askEvidenceRepository: targetAskEvidenceRepository(
        targetAskEvidencePool({ missingCatalog: true }),
      ),
    });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload(),
    });

    expect(response.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("unavailable");
    expect(response.body.evidenceReferences).toEqual([]);
    expect(response.body.unavailableData).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "source_not_in_catalog",
          requestedToolId: "get_booking_performance",
        }),
      ]),
    );
    expect(auditRepository.records[0]).toMatchObject({
      status: "unavailable",
      evidenceIds: [],
    });
  });

  it("returns a stale-source partial answer for stale target evidence", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    app = buildAskApp({
      auditRepository,
      askEvidenceRepository: targetAskEvidenceRepository(
        targetAskEvidencePool({
          metricRows: targetMetricRows({
            directShareFreshnessStatus: "stale",
            directShareQuality: "stale",
          }),
          setupRows: [],
        }),
      ),
    });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload(),
    });

    expect(response.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("partial");
    expect(response.body.evidenceReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceId: "metric_target_direct_share",
          freshness: expect.objectContaining({ status: "stale" }),
          quality: "stale",
        }),
      ]),
    );
    expect(response.body.unavailableData).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "stale_source" })]),
    );
    expect(auditRepository.records[0]).toMatchObject({
      status: "partial",
      evidenceIds: expect.arrayContaining(["metric_target_direct_share"]),
    });
  });

  it("returns structured source-unavailable data when the target repository fails", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    app = buildAskApp({
      auditRepository,
      askEvidenceRepository: targetAskEvidenceRepository(targetAskEvidencePool({ fail: true })),
    });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload(),
    });

    expect(response.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("unavailable");
    expect(response.body.evidenceReferences).toEqual([]);
    expect(response.body.unavailableData).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "source_unavailable",
          requestedToolId: "get_booking_performance",
        }),
      ]),
    );
    expect(auditRepository.records[0]).toMatchObject({
      status: "unavailable",
      evidenceIds: [],
    });
  });

  it("requires an explicit booking hotel resource in the Ask request body", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    app = buildAskApp({ auditRepository });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload({
        scope: {
          organizationId: "org_hotel_group",
        },
      }),
    });

    expect(response.statusCode).toBe(400);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("needs_clarification");
    expect(response.body.unavailableData[0].reason).toBe("missing_scope");
    expect(auditRepository.records[0].status).toBe("needs_clarification");
  });

  it("returns unavailable for approved catalog questions whose source is not loaded", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    app = buildAskApp({ auditRepository });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload({ question: "Where is my conversion funnel leaking?" }),
    });

    expect(response.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("unavailable");
    expect(response.body.unavailableData[0]).toMatchObject({
      reason: "source_unavailable",
      requestedToolId: "get_conversion_funnel",
    });
    expect(auditRepository.records[0]).toMatchObject({
      status: "unavailable",
      toolCallIds: ["ask_tool_call_1_get_conversion_funnel"],
      evidenceIds: [],
    });
  });

  it("returns external_data_needed for deferred enrichment questions", async () => {
    app = buildAskApp();

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload({ question: "Are nearby competitors raising prices?" }),
    });

    expect(response.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("external_data_needed");
    expect(response.body.unavailableData[0].reason).toBe("external_data_needed");
  });

  it("returns not_authorized and audits cross-tenant benchmark questions", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    app = buildAskApp({ auditRepository });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload({ question: "Benchmark my hotel against all hotels." }),
    });

    expect(response.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("not_authorized");
    expect(response.body.audit.deniedToolCallIds).toHaveLength(1);
    expect(auditRepository.records[0]).toMatchObject({
      status: "not_authorized",
      deniedToolCallIds: response.body.audit.deniedToolCallIds,
      toolPlan: { kind: "cross_tenant" },
    });
  });

  it("returns not_authorized for another organization's booking hotel", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    app = buildAskApp({ auditRepository });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload({
        scope: {
          organizationId: "org_other_hotel_group",
          bookingHotelId: "booking_hotel_bellevue",
          dateRange: { from: "2026-06-01", to: "2026-06-30" },
        },
      }),
    });

    expect(response.statusCode).toBe(403);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("not_authorized");
    expect(response.body.unavailableData[0]).toMatchObject({
      reason: "not_linked_resource",
      requestedResource: {
        type: "booking_hotel",
        id: "booking_hotel_bellevue",
      },
    });
    expect(auditRepository.records[0]).toMatchObject({
      bookingHotelId: "booking_hotel_bellevue",
      status: "not_authorized",
    });
  });

  it("rejects a body organization that does not match the selected request context", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    app = buildAskApp({ auditRepository });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload({
        scope: {
          organizationId: "org_other_hotel_group",
          bookingHotelId: "booking_hotel_alpenrose",
          dateRange: { from: "2026-06-01", to: "2026-06-30" },
        },
      }),
    });

    expect(response.statusCode).toBe(403);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("not_authorized");
    expect(response.body.unavailableData[0]).toMatchObject({
      unavailableDataId: "unavailable_ask_organization_scope",
      reason: "not_linked_resource",
    });
    expect(auditRepository.records[0]).toMatchObject({
      organizationId: "org_hotel_group",
      bookingHotelId: "booking_hotel_alpenrose",
      status: "not_authorized",
      deniedToolCallIds: ["tool_call_ask_organization_denied"],
    });
  });

  it("rejects stale selected-property state when the booking hotel is not linked", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    app = buildAskApp({ auditRepository });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload({
        scope: {
          organizationId: "org_hotel_group",
          bookingHotelId: "booking_hotel_stale_local_storage",
          dateRange: { from: "2026-06-01", to: "2026-06-30" },
        },
      }),
    });

    expect(response.statusCode).toBe(403);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("not_authorized");
    expect(response.body.unavailableData[0]).toMatchObject({
      reason: "not_linked_resource",
      requestedResource: {
        type: "booking_hotel",
        id: "booking_hotel_stale_local_storage",
      },
    });
    expect(auditRepository.records[0]).toMatchObject({
      organizationId: "org_hotel_group",
      bookingHotelId: "booking_hotel_stale_local_storage",
      status: "not_authorized",
    });
  });

  it("returns not_authorized when Ask permission is missing", async () => {
    app = buildAskApp({ permissions: [] });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload(),
    });

    expect(response.statusCode).toBe(403);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("not_authorized");
    expect(response.body.unavailableData[0].reason).toBe("missing_permission");
  });

  it("returns not_authorized when Booking Engine entitlement is inactive", async () => {
    app = buildAskApp({
      entitlements: [
        {
          product: "booking",
          key: "booking-engine",
          status: "suspended",
        },
      ],
    });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload(),
    });

    expect(response.statusCode).toBe(403);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("not_authorized");
    expect(response.body.unavailableData[0].reason).toBe("inactive_entitlement");
    expect(response.body.evidenceReferences).toEqual([]);
  });

  it("returns not_authorized when Ask tool permissions are missing", async () => {
    app = buildAskApp({ permissions: ["intelligence.ask.read", "booking.settings.read"] });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload(),
    });

    expect(response.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("not_authorized");
    expect(response.body.unavailableData).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "missing_permission",
          requestedToolId: "get_booking_performance",
        }),
      ]),
    );
    expect(response.body.evidenceReferences).toEqual([]);
  });

  it("audits budget exhaustion from a misbehaving model", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    const model = new RepeatingToolCallModel();
    app = buildAskApp({
      auditRepository,
      askModel: model,
      askBudgets: { maxModelTurns: 1 },
    });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload(),
    });

    expect(response.statusCode).toBe(200);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("partial");
    expect(response.body.unavailableData.at(-1)).toMatchObject({
      reason: "tool_budget_exhausted",
    });
    expect(auditRepository.records[0]).toMatchObject({
      status: "partial",
      failure: "budget_exhausted",
      toolCallIds: ["call_loop_1"],
      evidenceIds: expect.arrayContaining(["ev_booking_direct_share"]),
    });
  });

  it("checks authentication before processing Ask request validation", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    app = buildAskApp({ auditRepository });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      payload: {},
    });

    expect(response.statusCode).toBe(401);
    expectValidAskAnswerEnvelope(response.body);
    expect(response.body.status).toBe("not_authorized");
    expect(auditRepository.records[0]).toMatchObject({
      actorInternalUserId: null,
      status: "not_authorized",
    });
  });

  it("validates route envelope and evidence-contract fixture answer shapes", async () => {
    app = buildAskApp();
    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload(),
    });

    expectValidAskAnswerEnvelope(response.body);
    for (const answer of loadEvidenceFixtureAnswers()) {
      expectEvidenceFixtureAnswerShape(answer);
    }
  });
});
