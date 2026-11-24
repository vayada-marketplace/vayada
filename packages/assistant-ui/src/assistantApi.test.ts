import { describe, expect, it, vi } from "vitest";
import {
  AssistantRequestError,
  AssistantUnavailableError,
  createAssistantApi,
  PendingActionRefusedError,
  readEvents,
  type AssistantEvent,
  type AssistantHttp,
} from "./assistantApi";

const scope = { propertyId: "f6853000-0000-4000-8000-000000000001", app: "pms" as const };

/** A body that arrives in the given pieces, as a slow connection would hand them over. */
function body(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const sse = (event: AssistantEvent) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

function httpError(status: number) {
  return Object.assign(new Error(`API Error: ${status}`), { status });
}

function fakeHttp(overrides: Partial<AssistantHttp> = {}): AssistantHttp {
  return {
    get: vi.fn(async () => ({}) as never),
    post: vi.fn(async () => ({}) as never),
    stream: vi.fn(async () => new Response(body())),
    ...overrides,
  };
}

describe("readEvents", () => {
  it("reads events split across pieces, skips keep-alives and unknown or broken events", async () => {
    const turn = sse({ type: "turn", conversationId: "c1", turnId: "t1" });
    const events: AssistantEvent[] = [];
    await readEvents(
      body(
        turn.slice(0, 10),
        turn.slice(10) + ": keep-alive\n\n",
        sse({ type: "text", text: "Hä" }).replace("ä", "ä"),
        'event: mystery\ndata: {"type":"mystery"}\n\ndata: {not json\n\n',
        sse({ type: "end", status: "done", reason: null }),
      ),
      (event) => events.push(event),
    );
    expect(events).toEqual([
      { type: "turn", conversationId: "c1", turnId: "t1" },
      { type: "text", text: "Hä" },
      { type: "end", status: "done", reason: null },
    ]);
  });

  it("keeps a multi-byte character that is split between two pieces", async () => {
    const bytes = new TextEncoder().encode(sse({ type: "text", text: "€" }));
    const cut = bytes.indexOf(0xe2) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    const events: AssistantEvent[] = [];
    await readEvents(stream, (event) => events.push(event));
    expect(events).toEqual([{ type: "text", text: "€" }]);
  });
});

describe("createAssistantApi", () => {
  it("asks with the scope, hands over each event and resolves with the last one", async () => {
    const stream = vi.fn(
      async () =>
        new Response(
          body(
            sse({ type: "turn", conversationId: "c1", turnId: "t1" }),
            sse({ type: "tool", toolCallId: "x", name: "rooms_list", status: "running" }),
            sse({ type: "end", status: "done", reason: null }),
          ),
        ),
    );
    const api = createAssistantApi(fakeHttp({ stream }));
    const seen: string[] = [];
    const last = await api.ask(scope, { question: "Which rooms?" }, (event) =>
      seen.push(event.type),
    );
    expect(stream).toHaveBeenCalledWith(
      "/api/ai/assistant/turns",
      { ...scope, question: "Which rooms?" },
      undefined,
    );
    expect(seen).toEqual(["turn", "tool", "end"]);
    expect(last).toEqual({ type: "end", status: "done", reason: null });
  });

  it("sends the chat's id when the question continues a chat", async () => {
    const stream = vi.fn(async () => new Response(body(sse({ type: "refused", reason: "busy" }))));
    const api = createAssistantApi(fakeHttp({ stream }));
    const last = await api.ask(
      scope,
      { question: "And tomorrow?", conversationId: "c1" },
      () => {},
    );
    expect(stream).toHaveBeenCalledWith(
      "/api/ai/assistant/turns",
      { ...scope, question: "And tomorrow?", conversationId: "c1" },
      undefined,
    );
    expect(last).toEqual({ type: "refused", reason: "busy" });
  });

  it("resolves with nothing when the connection breaks before the turn ends", async () => {
    // The first read gets the turn, the next one the network error.
    let reads = 0;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1)
          controller.enqueue(
            new TextEncoder().encode(sse({ type: "turn", conversationId: "c1", turnId: "t1" })),
          );
        else controller.error(new TypeError("network error"));
      },
    });
    const api = createAssistantApi(fakeHttp({ stream: async () => new Response(broken) }));
    const seen: string[] = [];
    await expect(
      api.ask(scope, { question: "Hi" }, (event) => seen.push(event.type)),
    ).resolves.toBe(undefined);
    expect(seen).toEqual(["turn"]);
  });

  it("says the assistant is off when its routes are not there (404)", async () => {
    const api = createAssistantApi(
      fakeHttp({
        stream: async () => new Response("{}", { status: 404 }),
        get: async () => {
          throw httpError(404);
        },
      }),
    );
    await expect(api.ask(scope, { question: "Hi" }, () => {})).rejects.toBeInstanceOf(
      AssistantUnavailableError,
    );
    await expect(api.list(scope)).rejects.toBeInstanceOf(AssistantUnavailableError);
  });

  it("reports any other refusal with its status", async () => {
    const api = createAssistantApi(
      fakeHttp({ stream: async () => new Response("{}", { status: 403 }) }),
    );
    const error = await api.ask(scope, { question: "Hi" }, () => {}).catch((caught) => caught);
    expect(error).toBeInstanceOf(AssistantRequestError);
    expect((error as AssistantRequestError).status).toBe(403);
  });

  it("lists, reads and stops with the scope in the address or body", async () => {
    const get = vi.fn(async () => ({ items: [], nextCursor: null }) as never);
    const post = vi.fn(async () => ({ stopped: true }) as never);
    const api = createAssistantApi(fakeHttp({ get, post }));
    await api.list(scope, "next/page", 5);
    expect(get).toHaveBeenLastCalledWith(
      `/api/ai/assistant/conversations?propertyId=${scope.propertyId}&app=pms&limit=5&cursor=next%2Fpage`,
    );
    await api.read(scope, "c1");
    expect(get).toHaveBeenLastCalledWith(
      `/api/ai/assistant/conversations/c1?propertyId=${scope.propertyId}&app=pms`,
    );
    await api.stop(scope, "c1", "t1");
    expect(post).toHaveBeenCalledWith("/api/ai/assistant/conversations/c1/stop", {
      ...scope,
      turnId: "t1",
    });
  });

  it("reads a chat that is gone (deleted after 30 days) as nothing", async () => {
    const api = createAssistantApi(
      fakeHttp({
        get: async () => {
          throw httpError(404);
        },
      }),
    );
    await expect(api.read(scope, "c1")).resolves.toBeUndefined();
  });

  it("reads a change's card, and nothing when there is none or changes are off (404)", async () => {
    const view = { id: "p1", state: "needs_answer", cardSha256: "a".repeat(64) };
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/p1")) return view as never;
      throw httpError(404);
    });
    const api = createAssistantApi(fakeHttp({ get }));
    await expect(api.pendingAction("p1")).resolves.toEqual(view);
    expect(get).toHaveBeenCalledWith("/api/ai/pending-actions/p1");
    await expect(api.pendingAction("p2")).resolves.toBeUndefined();
  });

  it("says why a change can't be seen at all (403): another account's, or someone else's", async () => {
    const refusal = (code?: string) =>
      Object.assign(httpError(403), code ? { data: { code, message: "x" } } : {});
    const get = vi
      .fn()
      .mockRejectedValueOnce(refusal("other_account"))
      .mockRejectedValueOnce(refusal("not_your_change"))
      .mockRejectedValueOnce(refusal("first_party_only"))
      .mockRejectedValueOnce(refusal()) as AssistantHttp["get"];
    const api = createAssistantApi(fakeHttp({ get }));
    for (const code of ["other_account", "not_your_change"]) {
      const error = await api.pendingAction("p1").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PendingActionRefusedError);
      expect((error as PendingActionRefusedError).code).toBe(code);
    }
    // Any other refusal stays a failed read, tried again.
    for (let n = 0; n < 2; n++) {
      const error = await api.pendingAction("p1").catch((caught: unknown) => caught);
      expect(error).not.toBeInstanceOf(PendingActionRefusedError);
      expect(error).toMatchObject({ status: 403 });
    }
  });

  it("sends a Yes bound to the card shown, a No without it", async () => {
    const post = vi.fn(async () => ({ id: "p1", state: "done" }) as never);
    const api = createAssistantApi(fakeHttp({ post }));
    const card = { id: "p1", cardSha256: "b".repeat(64) };
    await expect(api.answer(card, "yes")).resolves.toEqual({ id: "p1", state: "done" });
    expect(post).toHaveBeenLastCalledWith("/api/ai/pending-actions/p1/answer", {
      answer: "yes",
      cardSha256: "b".repeat(64),
    });
    await api.answer(card, "no");
    expect(post).toHaveBeenLastCalledWith("/api/ai/pending-actions/p1/answer", { answer: "no" });
  });

  it("hands back the change as it is now when the answer is refused (409, 403)", async () => {
    const current = { id: "p1", state: "changed" };
    const refused = Object.assign(httpError(409), {
      data: { code: "changed", pendingAction: current },
    });
    // A 503 may carry the change too, but then nobody knows whether the answer arrived.
    const unavailable = Object.assign(httpError(503), {
      data: { code: "unavailable", pendingAction: { id: "p1", state: "needs_answer" } },
    });
    const api = createAssistantApi(
      fakeHttp({
        post: vi
          .fn()
          .mockRejectedValueOnce(refused)
          .mockRejectedValueOnce(unavailable) as AssistantHttp["post"],
      }),
    );
    const card = { id: "p1", cardSha256: "c".repeat(64) };
    await expect(api.answer(card, "yes")).resolves.toEqual(current);
    await expect(api.answer(card, "yes")).rejects.toMatchObject({ status: 503 });
  });
});
