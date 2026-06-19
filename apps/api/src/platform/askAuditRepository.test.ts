import type { AskAuditRecord } from "@vayada/domain-intelligence";
import { describe, expect, it } from "vitest";

import {
  createPgAskAuditRepository,
  type AskAuditClient,
  type AskAuditPool,
} from "./askAuditRepository.js";

const ACTOR_ID = "f8541000-0000-0000-0000-000000000001";
const ORGANIZATION_ID = "f8542000-0000-0000-0000-000000000001";
const PROPERTY_ID = "f8543000-0000-0000-0000-000000000001";
const CONVERSATION_ID = "f8545000-0000-0000-0000-000000000001";
const RUN_ID = "f8545100-0000-0000-0000-000000000001";
const BOOKING_HOTEL_ID = "booking_hotel_audit_alpenrose";

type QueryCall = {
  text: string;
  values?: readonly unknown[];
};

describe("createPgAskAuditRepository", () => {
  it("persists Ask audit rows with target scope, model, usage, tool, and failure metadata", async () => {
    const { pool, queries, releases } = createRecordingPool();
    const repository = createPgAskAuditRepository({
      connectionString: "postgresql://target-db",
      pool,
    });

    await repository.recordAskRun(auditRecord());

    expect(queries.map((query) => query.text)).toEqual(
      expect.arrayContaining([
        "BEGIN",
        expect.stringContaining("FROM identity.organization_resource_links resource_link"),
        expect.stringContaining("INSERT INTO intelligence.ask_conversations"),
        expect.stringContaining("INSERT INTO intelligence.ask_runs"),
        expect.stringContaining("INSERT INTO intelligence.ask_tool_calls"),
        expect.stringContaining("INSERT INTO intelligence.ask_answer_audits"),
        "COMMIT",
      ]),
    );
    expect(releases.count).toBe(1);

    const conversationQuery = queryContaining(
      queries,
      "INSERT INTO intelligence.ask_conversations",
    );
    expect(conversationQuery.values?.[3]).toBe(PROPERTY_ID);
    expect(conversationQuery.text).toContain("NULL, $5");
    expect(conversationQuery.values?.[4]).toBe("property");
    expect(queryContaining(queries, "INSERT INTO intelligence.ask_runs").values?.[5]).toBe(
      "property",
    );
    const toolCallQuery = queryContaining(queries, "INSERT INTO intelligence.ask_tool_calls");
    expect(toolCallQuery.text).not.toContain("WHERE EXISTS");
    expect(toolCallQuery.values?.[4]).toBe("property");

    const serializedValues = JSON.stringify(queries.map((query) => query.values));
    expect(serializedValues).toContain("req_854");
    expect(serializedValues).toContain(ACTOR_ID);
    expect(serializedValues).toContain(ORGANIZATION_ID);
    expect(serializedValues).toContain(BOOKING_HOTEL_ID);
    expect(serializedValues).toContain("call_booking_performance");
    expect(serializedValues).toContain("gpt-5.4-mini");
    expect(serializedValues).toContain("provider_error");
    expect(serializedValues).toContain("inputTokens");
    expect(serializedValues).toContain("120");
    expect(serializedValues).toContain("[redacted-email]");
    expect(serializedValues).toContain("[redacted-phone]");
    expect(serializedValues).not.toContain("guest@example.com");
    expect(serializedValues).not.toContain("guest.block@example.com");
    expect(serializedValues).not.toContain("+49 3012345678");
  });

  it("persists organization-scope Ask audit rows without resolving a booking hotel", async () => {
    const { pool, queries } = createRecordingPool();
    const repository = createPgAskAuditRepository({
      connectionString: "postgresql://target-db",
      pool,
    });

    await repository.recordAskRun({
      ...auditRecord(),
      bookingHotelId: null,
      scope: { organizationId: ORGANIZATION_ID },
      status: "needs_clarification",
      summary: "Ask needs a selected hotel.",
      blocks: [],
      toolPlan: null,
      toolResults: [],
      toolCallIds: [],
      deniedToolCallIds: [],
      evidenceIds: [],
      evidenceReferences: [],
      unavailableData: [{ unavailableDataId: "missing_scope", reason: "missing_scope" }],
      confidence: { level: "unknown", reasons: ["missing_scope"] },
      suggestedActions: [],
      followUpQuestions: ["Which hotel should I inspect?"],
    });

    expect(queries.map((query) => query.text).join("\n")).not.toContain(
      "FROM identity.organization_resource_links resource_link",
    );
    const conversationQuery = queryContaining(
      queries,
      "INSERT INTO intelligence.ask_conversations",
    );
    expect(conversationQuery.values?.[3]).toBeNull();
    expect(conversationQuery.text).toContain("NULL, $5");
    expect(conversationQuery.values?.[4]).toBe("organization");
    expect(queryContaining(queries, "INSERT INTO intelligence.ask_runs").values?.[5]).toBe(
      "organization",
    );
    expect(queryContaining(queries, "INSERT INTO intelligence.ask_answer_audits").values?.[5]).toBe(
      "organization",
    );
  });
});

function queryContaining(queries: QueryCall[], pattern: string): QueryCall {
  const query = queries.find((entry) => entry.text.includes(pattern));
  if (!query) throw new Error(`Missing query containing ${pattern}`);
  return query;
}

function createRecordingPool(): {
  pool: AskAuditPool;
  queries: QueryCall[];
  releases: { count: number };
} {
  const queries: QueryCall[] = [];
  const releases = { count: 0 };
  const client = {
    async query(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      if (text.includes("FROM identity.organization_resource_links resource_link")) {
        return {
          rows: [{ propertyId: PROPERTY_ID }],
          rowCount: 1,
        };
      }
      if (text.includes("INSERT INTO intelligence.ask_conversations")) {
        return { rows: [{ id: CONVERSATION_ID }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO intelligence.ask_runs")) {
        return { rows: [{ id: RUN_ID }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      releases.count += 1;
    },
  } as unknown as AskAuditClient;

  return {
    pool: {
      async connect() {
        return client;
      },
      async end() {
        throw new Error("injected pool should not be closed by repository");
      },
    },
    queries,
    releases,
  };
}

function auditRecord(): AskAuditRecord {
  return {
    answerId: "ask_answer_req_854",
    conversationId: "ask_conversation_req_854",
    runId: "ask_run_req_854",
    contractVersion: "ask-intelligence-evidence.v1",
    generatedAt: "2026-06-19T12:00:01.000Z",
    question: "Can you email guest@example.com and explain my direct booking share?",
    scope: {
      organizationId: ORGANIZATION_ID,
      bookingHotelId: BOOKING_HOTEL_ID,
      dateRange: { from: "2026-06-01", to: "2026-06-30" },
      locale: "en",
      currency: "EUR",
    },
    status: "partial",
    summary: "Direct booking share is available from approved booking evidence.",
    blocks: [
      {
        type: "metric",
        metricKey: "booking.direct_booking_share",
        label: "Guest guest.block@example.com asked for +49 3012345678",
        value: 62.5,
        unit: "percentage",
        evidenceIds: ["ev_booking_direct_share"],
      },
    ],
    requestId: "req_854",
    actorInternalUserId: ACTOR_ID,
    organizationId: ORGANIZATION_ID,
    bookingHotelId: BOOKING_HOTEL_ID,
    toolPlan: {
      kind: "run_tools",
      intent: "booking_performance",
      toolPlan: [
        {
          toolId: "get_booking_performance",
          metricKeys: ["booking.direct_booking_share"],
        },
      ],
    },
    toolResults: [
      {
        toolCallId: "call_booking_performance",
        toolId: "get_booking_performance",
        status: "available",
        inputScope: {
          organizationId: ORGANIZATION_ID,
          bookingHotelId: BOOKING_HOTEL_ID,
          dateRange: { from: "2026-06-01", to: "2026-06-30" },
        },
        filters: { channel: "direct" },
        evidence: [
          {
            evidenceId: "ev_booking_direct_share",
            sourceOwner: "booking",
            sourceView: "direct_booking_summary_read_model",
            product: "booking",
            resourceId: BOOKING_HOTEL_ID,
            resourceType: "booking_hotel",
            metricKey: "booking.direct_booking_share",
            filters: { dateRange: { from: "2026-06-01", to: "2026-06-30" } },
            freshness: { status: "fresh", generatedAt: "2026-06-19T11:55:00.000Z" },
            quality: "complete",
            sampleSize: 48,
            aggregateId: "booking.direct_booking_share.audit-test",
            valueSummary: { directSharePct: 62.5 },
          },
        ],
        unavailableData: [],
        audit: {
          requestId: "req_854",
          actorInternalUserId: ACTOR_ID,
          organizationId: ORGANIZATION_ID,
          resourceId: BOOKING_HOTEL_ID,
          permissionKeys: ["intelligence.ask.read", "booking.analytics.read"],
        },
      },
    ],
    toolCallIds: ["call_booking_performance"],
    deniedToolCallIds: ["call_denied_finance"],
    evidenceIds: ["ev_booking_direct_share"],
    evidenceReferences: [
      {
        evidenceId: "ev_booking_direct_share",
        toolCallId: "call_booking_performance",
        toolId: "get_booking_performance",
        sourceOwner: "booking",
        sourceView: "direct_booking_summary_read_model",
        resource: { type: "booking_hotel", id: BOOKING_HOTEL_ID },
        metricKey: "booking.direct_booking_share",
      },
    ],
    unavailableData: [
      {
        unavailableDataId: "unavailable_provider_error",
        reason: "provider_unavailable",
      },
    ],
    caveats: [{ label: "Do not include guest.block@example.com in the answer." }],
    confidence: { level: "low", reasons: ["tool_failures"] },
    suggestedActions: [
      {
        type: "view_report",
        label: "View the underlying report for +49 3012345678",
        evidenceIds: ["ev_booking_direct_share"],
      },
    ],
    followUpQuestions: [],
    modelProvider: "openai",
    modelName: "gpt-5.4-mini",
    promptVersion: "ask-prompt.v1",
    answerSchemaVersion: "ask-answer-schema.v1",
    traceId: "trace_req_854",
    modelResponseIds: ["response_req_854"],
    modelRequestIds: ["model_request_req_854"],
    latencyMs: 1234,
    usage: {
      requests: 2,
      inputTokens: 120,
      outputTokens: 44,
      totalTokens: 164,
    },
    estimatedCostUsd: null,
    failure: "provider_error",
  };
}
