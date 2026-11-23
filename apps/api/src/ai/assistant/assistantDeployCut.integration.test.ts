import { randomUUID } from "node:crypto";

import type { RequestContext } from "@vayada/backend-auth";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "../../hotelSetupOrdinaryLogin.fixture.js";
import { registerAssistantRoutes } from "../../routes/assistant.js";
import type { AiStepResult } from "../provider/aiProvider.js";
import type { ModelRoute } from "../provider/catalog.js";
import { createAssistantRuntime } from "./assistantRuntime.js";
import type { AssistantTool } from "./assistantTurn.js";
import {
  createPgConversationStore,
  type ConversationStore,
  type ConversationView,
} from "./conversationStore.js";
import { requestContract } from "./requestContract.js";

/**
 * VAY-2518 acceptance criterion: "A deploy during a turn leaves a readable conversation that says
 * what did and did not happen." Through the real route, runtime and PostgreSQL store, written by the
 * ordinary API login; only the model is scripted.
 */
const url = process.env["TEST_DATABASE_URL"];
const SONNET: ModelRoute = {
  provider: "bedrock",
  region: "eu-west-1",
  model: "eu.anthropic.claude-sonnet-5-5",
};
const RECORD = {
  route: SONNET,
  usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 },
  costMicroUsd: 1,
  priceTableVersion: "2026-11-20",
  latencyMs: 1,
};
const call = (toolCallId: string, propertyId: string) => ({
  type: "tool-call",
  toolCallId,
  toolName: "rooms_list",
  input: { propertyId },
});

describe.skipIf(!url)("assistant: a deploy during a turn (VAY-2518)", () => {
  let admin: pg.Client;
  let fixture: HotelSetupOrdinaryLoginFixture;
  let pool: pg.Pool;
  let store: ConversationStore;
  const org = randomUUID();
  const user = randomUUID();
  const property = randomUUID();
  const owner = { organizationId: org, propertyId: property, userId: user, app: "pms" as const };

  function appWith(steps: (() => Promise<AiStepResult>)[], tools: AssistantTool[]) {
    const runtime = createAssistantRuntime({
      store,
      provider: {
        routeFor: () => SONNET,
        step: async () => {
          const next = steps.shift();
          if (!next) throw new Error("no more steps");
          return next();
        },
      },
      toolsFor: async () => tools,
      // A deploy gives 30 s; the test gives the turn 50 ms before it is cut.
      drainGraceMs: 50,
    });
    const app = Fastify({ logger: false });
    app.decorateRequest("authContext", null);
    app.addHook("onRequest", async (request) => {
      request.authContext = {
        actor: { internalUserId: user },
        selectedOrganization: { organizationId: org, kind: "hotel_group", status: "active" },
        audit: { source: "session", requestId: "req" },
      } as unknown as RequestContext;
    });
    void app.register(registerAssistantRoutes, { prefix: "/api/ai", runtime });
    // As app.ts wires it: a root preClose hook.
    app.addHook("preClose", async () => {
      await runtime.drain();
    });
    return app;
  }

  async function reload(app: FastifyInstance, conversationId: string): Promise<ConversationView> {
    const response = await app.inject({
      url: `/api/ai/assistant/conversations/${conversationId}?propertyId=${property}&app=pms`,
    });
    expect(response.statusCode).toBe(200);
    return response.json<ConversationView>();
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, workos_org_id)
       VALUES ($1::uuid, 'hotel_group', 'VAY-2518 hotel', $1::text, 'wk-org-' || $1::text)`,
      [org],
    );
    await admin.query(
      "INSERT INTO identity.users (id, email, name, status) VALUES ($1::uuid, $2, 'VAY-2518', 'active')",
      [user, `vay2518-cut-${user}@example.test`],
    );
    await admin.query(
      "INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1::uuid, $2, 'Hotel Alpenrose')",
      [property, `vay-2518-cut-${property}`],
    );
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    pool = new pg.Pool({ connectionString: fixture.connectionString, max: 4 });
    store = createPgConversationStore({ pool });
  });

  afterAll(async () => {
    await pool?.end();
    await fixture?.drop();
    if (admin) {
      await admin.query("DELETE FROM platform.ai_conversations WHERE organization_id = $1::uuid", [
        org,
      ]);
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = $1::uuid", [property]);
      await admin.query("DELETE FROM identity.users WHERE id = $1::uuid", [user]);
      await admin.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [org]);
      await admin.end();
    }
  });

  it("drained at SIGTERM: what ran is stored, what didn't is marked, the turn is interrupted", async () => {
    let started!: () => void;
    const toolStarted = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const rooms: AssistantTool = {
      definition: {
        name: "rooms_list",
        description: "Lists rooms.",
        inputSchema: {},
        outputSchema: {},
      },
      run: async () => {
        started();
        await gate; // A route still answering when the deploy starts.
        return { ok: true, data: { rooms: ["Deluxe"] } };
      },
    };
    const app = appWith(
      [
        async () => ({
          ok: true,
          finishReason: "tool-calls",
          messages: [
            {
              role: "assistant",
              content: [call("toolu_cut1", property), call("toolu_cut2", randomUUID())],
            },
          ],
          ...RECORD,
        }),
      ],
      [rooms],
    );
    await app.ready();

    const streaming = app.inject({
      method: "POST",
      url: "/api/ai/assistant/turns",
      payload: { propertyId: property, app: "pms", question: "Which rooms do we have?" },
    });
    await toolStarted;
    // The deploy: SIGTERM closes the server; the running turn gets its grace, then is cut.
    const closing = app.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const response = await streaming;
    await closing;

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      'data: {"type":"end","status":"interrupted","reason":"shutdown"}',
    );
    const conversationId = /"conversationId":"([0-9a-f-]{36})"/.exec(response.body)![1]!;

    // The reload after the deploy, from the next API task.
    const next = appWith([], [rooms]);
    const view = await reload(next, conversationId);
    await next.close();
    expect(view.turns).toMatchObject([{ status: "interrupted", endReason: "shutdown" }]);
    const parts = view.messages.flatMap((row) =>
      (row.message.content as { type: string; toolCallId?: string; output?: unknown }[]).map(
        (part) => ({ role: row.message.role, ...part }),
      ),
    );
    expect(parts.filter((part) => part.role === "tool")).toEqual([
      // Ran: its answer is kept.
      expect.objectContaining({
        toolCallId: "toolu_cut1",
        output: { type: "json", value: { rooms: ["Deluxe"] } },
      }),
      // Did not run: said so.
      expect.objectContaining({
        toolCallId: "toolu_cut2",
        output: {
          type: "error-json",
          value: {
            code: "not_run",
            message: "The server restarted before this ran. Ask again in a moment.",
          },
        },
      }),
    ]);
  });

  it("killed outright: the next reload says the turn was cut off and its step may have run", async () => {
    const contract = requestContract({ route: SONNET, systemPrompt: "x", tools: [] });
    const started = await store.startTurn({
      owner,
      contract,
      message: { role: "user", content: "Block room 101 tonight" },
    });
    if (started.status !== "started") throw new Error(started.status);
    await store.append(started.turnId, [
      { role: "assistant", content: [call("toolu_kill1", property)] },
    ]);
    // The task died without a word: its heartbeat stopped two minutes ago.
    await admin.query(
      "UPDATE platform.ai_conversation_turns SET heartbeat_at = now() - interval '2 minutes' WHERE id = $1::uuid",
      [started.turnId],
    );

    const app = appWith([], []);
    const view = await reload(app, started.conversationId);
    await app.close();
    expect(view.turns).toMatchObject([{ status: "interrupted", endReason: "no_heartbeat" }]);
    expect(view.messages.at(-1)!.message).toMatchObject({
      role: "tool",
      content: [
        {
          toolCallId: "toolu_kill1",
          output: {
            type: "error-json",
            value: {
              error: "interrupted",
              detail:
                "The answer was cut off before this step's result was recorded. It may or may " +
                "not have run: check before doing it again.",
            },
          },
        },
      ],
    });
  });
});
