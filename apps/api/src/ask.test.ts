import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type ProductEntitlement,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import {
  createInMemoryAskAuditRepository,
  type AskAnswer,
  type AskAuditRecord,
  type AskAuditRepository,
} from "./routes/ask.js";

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;

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
  } = {},
): ReturnType<typeof buildApp> {
  return buildApp({
    logger: false,
    askAuditRepository: options.auditRepository ?? createInMemoryAskAuditRepository(),
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["intelligence.ask.read"];
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
    expect(auditRepository.records).toMatchObject([
      {
        actorInternalUserId: "user_hotel_owner",
        organizationId: "org_hotel_group",
        bookingHotelId: "booking_hotel_alpenrose",
        status: "answered",
      },
    ]);
  });

  it("returns partial setup completeness fixture answers", async () => {
    app = buildAskApp();

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
    app = buildAskApp();

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

  it("returns not_authorized and audits tenant-scope rejection", async () => {
    const auditRepository = createInMemoryAskAuditRepository();
    app = buildAskApp({ auditRepository });

    const response = await injectJson<AskAnswer>(app, {
      method: "POST",
      url: "/api/ai/ask",
      headers: { authorization: "Bearer valid-token" },
      payload: askPayload({
        scope: {
          organizationId: "org_hotel_group",
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
