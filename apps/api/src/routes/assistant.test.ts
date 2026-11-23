import type { RequestContext, RequestSource } from "@vayada/backend-auth";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AssistantRuntime, RunTurn } from "../ai/assistant/assistantRuntime.js";
import type { ConversationSummary } from "../ai/assistant/conversationStore.js";
import { MAX_QUESTION_CHARS, registerAssistantRoutes } from "./assistant.js";

/** VAY-2518: the assistant's API for the panel, with the runtime faked. */
const ORG = "25180000-0000-4000-8000-000000000001";
const USER = "25180000-0000-4000-8000-000000000002";
const PROPERTY = "25180000-0000-4000-8000-000000000003";
const CHAT = "25180000-0000-4000-8000-000000000004";

function fakeRuntime(overrides: Partial<AssistantRuntime> = {}): AssistantRuntime {
  return {
    prepareTurn: vi.fn(async () => undefined),
    read: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    stop: vi.fn(async () => false),
    drain: vi.fn(async () => undefined),
    ...overrides,
  };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function routeApp(
  runtime: AssistantRuntime,
  options: {
    source?: RequestSource;
    kind?: "hotel_group" | "platform";
    keepAliveMs?: number;
    logs?: string[];
  } = {},
) {
  const logs = options.logs;
  const app = Fastify({
    logger: logs
      ? { level: "warn", stream: { write: (line: string) => void logs.push(line) } }
      : false,
  });
  apps.push(app);
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    request.authContext = {
      actor: {
        internalUserId: USER,
        providerIdentity: { provider: "workos", providerUserId: "user_1" },
        email: "user@example.com",
        status: "active",
      },
      selectedOrganization: {
        organizationId: ORG,
        kind: options.kind ?? "hotel_group",
        status: "active",
      },
      membership: {
        membershipId: "25180000-0000-4000-8000-0000000000ff",
        status: "active",
        roleKey: "front_desk",
        workosRoleSlugs: [],
        permissions: [],
      },
      audit: { source: options.source ?? "session", requestId: "req-1" },
    } as unknown as RequestContext;
  });
  await app.register(registerAssistantRoutes, {
    prefix: "/api/ai",
    runtime,
    ...(options.keepAliveMs ? { keepAliveMs: options.keepAliveMs } : {}),
  });
  return app;
}

const ask = (app: FastifyInstance, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/ai/assistant/turns", payload: body });
const QUESTION = { propertyId: PROPERTY, app: "pms", question: "Which rooms do we have?" };

/** The events of a server-sent-events body, in order. */
function events(body: string) {
  return body
    .split("\n\n")
    .filter((block) => block.startsWith("event: "))
    .map((block) => {
      const [eventLine, dataLine] = block.split("\n");
      return { event: eventLine!.slice(7), data: JSON.parse(dataLine!.slice(6)) as unknown };
    });
}

describe("assistant routes (VAY-2518)", () => {
  it("streams a turn as server-sent events and ends the response with the turn", async () => {
    const run: RunTurn = async (emit) => {
      emit({ type: "turn", conversationId: CHAT, turnId: "25180000-0000-4000-8000-000000000005" });
      emit({ type: "text", text: "You have " });
      emit({ type: "text", text: "two rooms." });
      const end = { type: "end" as const, status: "done" as const, reason: null };
      emit(end);
      return end;
    };
    const prepareTurn = vi.fn(async () => run);
    const app = await routeApp(fakeRuntime({ prepareTurn }));
    const response = await ask(app, { ...QUESTION, conversationId: CHAT });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(events(response.body)).toEqual([
      {
        event: "turn",
        data: {
          type: "turn",
          conversationId: CHAT,
          turnId: "25180000-0000-4000-8000-000000000005",
        },
      },
      { event: "text", data: { type: "text", text: "You have " } },
      { event: "text", data: { type: "text", text: "two rooms." } },
      { event: "end", data: { type: "end", status: "done", reason: null } },
    ]);
    expect(prepareTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId: PROPERTY,
        app: "pms",
        conversationId: CHAT,
        question: "Which rooms do we have?",
      }),
    );
  });

  it("keeps a long turn's connection open with a comment every interval", async () => {
    const run: RunTurn = async (emit) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const end = { type: "end" as const, status: "done" as const, reason: null };
      emit(end);
      return end;
    };
    const app = await routeApp(fakeRuntime({ prepareTurn: async () => run }), { keepAliveMs: 10 });
    const response = await ask(app, QUESTION);
    expect(response.body).toContain(": keep-alive\n\n");
    expect(events(response.body).at(-1)).toMatchObject({ event: "end" });
  });

  it("ends the stream with internal_error when the turn throws, and logs no text", async () => {
    const run: RunTurn = async () => {
      throw new Error("relation pms.rooms: Maria Schmidt");
    };
    const logs: string[] = [];
    const app = await routeApp(fakeRuntime({ prepareTurn: async () => run }), { logs });
    const response = await ask(app, QUESTION);
    expect(events(response.body)).toEqual([
      { event: "end", data: { type: "end", status: "failed", reason: "internal_error" } },
    ]);
    expect(logs.join("")).toContain("Assistant turn failed");
    expect(logs.join("")).not.toContain("Maria");
  });

  it("gives each turn a request id of its own, not the server's request counter", async () => {
    const prepareTurn = vi.fn(async () => undefined);
    const app = await routeApp(fakeRuntime({ prepareTurn }));
    await ask(app, QUESTION);
    await ask(app, QUESTION);
    const ids = prepareTurn.mock.calls.map(
      (args) => (args as unknown as [{ requestId: string }])[0].requestId,
    );
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it.each([
    [{ ...QUESTION, propertyId: "not-a-uuid" }, "propertyId"],
    [{ ...QUESTION, app: "marketplace" }, "app"],
    [{ ...QUESTION, question: "   " }, "question"],
    [{ ...QUESTION, question: "x".repeat(MAX_QUESTION_CHARS + 1) }, "question"],
    [{ ...QUESTION, conversationId: "chat-1" }, "conversationId"],
  ])("refuses a bad request (%o)", async (body, field) => {
    const prepareTurn = vi.fn();
    const app = await routeApp(fakeRuntime({ prepareTurn }));
    const response = await ask(app, body);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "invalid_request" });
    expect((response.json() as { message: string }).message).toContain(field);
    expect(prepareTurn).not.toHaveBeenCalled();
  });

  it("refuses an AI, a platform account and a property the person may not use", async () => {
    const prepareTurn = vi.fn(async () => undefined);
    for (const options of [
      { source: "agent" as RequestSource },
      { kind: "platform" as const },
      {},
    ]) {
      const app = await routeApp(fakeRuntime({ prepareTurn }), options);
      const response = await ask(app, QUESTION);
      expect(response.statusCode).toBe(403);
    }
    // Only the last one got as far as the property check.
    expect(prepareTurn).toHaveBeenCalledTimes(1);
  });

  it("lists the person's chats page by page", async () => {
    const chat = (n: number): ConversationSummary => ({
      id: `25180000-0000-4000-8000-00000000001${n}`,
      readOnlyReason: null,
      preview: `Question ${n}`,
      createdAt: "2026-11-23T08:00:00.000001+00:00",
      lastActivityAt: `2026-11-23T08:00:0${n}.000123+00:00`,
    });
    const list = vi.fn(async () => [chat(3), chat(2), chat(1)]);
    const app = await routeApp(fakeRuntime({ list }));
    const first = await app.inject({
      url: `/api/ai/assistant/conversations?propertyId=${PROPERTY}&app=booking_admin&limit=2`,
    });
    expect(first.statusCode).toBe(200);
    const page = first.json<{ items: ConversationSummary[]; nextCursor: string | null }>();
    expect(page.items.map((item) => item.preview)).toEqual(["Question 3", "Question 2"]);
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ propertyId: PROPERTY, app: "booking_admin" }),
      { limit: 3 },
    );
    await app.inject({
      url: `/api/ai/assistant/conversations?propertyId=${PROPERTY}&app=booking_admin&limit=2&cursor=${page.nextCursor}`,
    });
    expect(list).toHaveBeenLastCalledWith(expect.anything(), {
      limit: 3,
      before: { lastActivityAt: chat(2).lastActivityAt, id: chat(2).id },
    });
    const bad = await app.inject({
      url: `/api/ai/assistant/conversations?propertyId=${PROPERTY}&app=pms&cursor=nonsense`,
    });
    expect(bad.statusCode).toBe(422);
  });

  it("reads one chat, 404 when it isn't the person's", async () => {
    const view = {
      id: CHAT,
      readOnlyReason: null,
      createdAt: "x",
      lastActivityAt: "y",
      turns: [],
      messages: [],
    };
    const read = vi.fn(async (_scope: unknown, id: string) => (id === CHAT ? view : undefined));
    const app = await routeApp(fakeRuntime({ read }));
    const mine = await app.inject({
      url: `/api/ai/assistant/conversations/${CHAT}?propertyId=${PROPERTY}&app=pms`,
    });
    expect(mine.json()).toEqual(view);
    const other = await app.inject({
      url: `/api/ai/assistant/conversations/25180000-0000-4000-8000-000000000099?propertyId=${PROPERTY}&app=pms`,
    });
    expect(other.statusCode).toBe(404);
  });

  it("stops a turn of the person's own chat, the one they mean", async () => {
    const stop = vi.fn(async () => true);
    const app = await routeApp(fakeRuntime({ stop }));
    const TURN = "25180000-0000-4000-8000-00000000000A";
    const response = await app.inject({
      method: "POST",
      url: `/api/ai/assistant/conversations/${CHAT}/stop`,
      payload: { propertyId: PROPERTY, app: "pms", turnId: TURN },
    });
    expect(response.json()).toEqual({ stopped: true });
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId: PROPERTY }),
      CHAT,
      TURN.toLowerCase(),
    );
    const bad = await app.inject({
      method: "POST",
      url: `/api/ai/assistant/conversations/${CHAT}/stop`,
      payload: { propertyId: PROPERTY, app: "pms", turnId: "latest" },
    });
    expect(bad.statusCode).toBe(422);
  });
});
