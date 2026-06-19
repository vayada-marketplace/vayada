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
import { Usage, type Model, type ModelRequest, type ModelResponse } from "@openai/agents";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
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
  } = {},
): ReturnType<typeof buildApp> {
  return buildApp({
    logger: false,
    askAuditRepository: options.auditRepository ?? createInMemoryAskAuditRepository(),
    askModel: options.askModel,
    askBudgets: options.askBudgets,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository,
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

function expectAskOwnerSeedGrants(roleKey: "hotel_owner" | "owner"): void {
  const sql = askRoleGrantSeedSql();
  for (const permission of askOwnerPermissions) {
    expect(sql).toMatch(new RegExp(`\\('hotel_group',\\s*'${roleKey}',\\s*'${permission}'\\)`));
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

  it("returns needs_clarification when explicit Ask scope is incomplete", async () => {
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

    expect(response.statusCode).toBe(200);
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
