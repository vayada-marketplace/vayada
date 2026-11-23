import type { RequestContext } from "@vayada/backend-auth";
import { describe, expect, it, vi } from "vitest";

import type { AiStepInput, AiStepOptions, AiStepResult } from "../provider/aiProvider.js";
import type { ModelRoute } from "../provider/catalog.js";
import { createAssistantRuntime, type AssistantToolsFor } from "./assistantRuntime.js";
import type { AssistantEvent, AssistantTool } from "./assistantTurn.js";
import { memoryConversationStore } from "./memoryConversationStore.fixtures.js";

/** VAY-2518: the assistant inside one API task: access, Stop and the drain at shutdown. */
const SONNET: ModelRoute = {
  provider: "bedrock",
  region: "eu-west-1",
  model: "eu.anthropic.claude-sonnet-5-5",
};
const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000003";
const PROPERTY = "00000000-0000-4000-8000-000000000002";
const session = {
  actor: { internalUserId: USER },
  selectedOrganization: { organizationId: ORG, kind: "hotel_group" },
} as unknown as RequestContext;
const scope = { session, propertyId: PROPERTY, app: "pms" as const };
const RECORD = {
  route: SONNET,
  usage: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 },
  costMicroUsd: 1,
  priceTableVersion: "2026-11-20",
  latencyMs: 1,
};
const answer = (text: string): AiStepResult => ({
  ok: true,
  finishReason: "stop",
  messages: [{ role: "assistant", content: [{ type: "text", text }] }],
  ...RECORD,
});
const tool: AssistantTool = {
  definition: {
    name: "rooms_list",
    description: "Lists rooms.",
    inputSchema: {},
    outputSchema: {},
  },
  run: async () => ({ ok: true, data: { rooms: [] } }),
};

type Step = (input: AiStepInput, options: AiStepOptions) => Promise<AiStepResult>;

function runtimeWith(
  steps: Step[],
  options: { toolsFor?: AssistantToolsFor; timeZoneOf?: () => Promise<string | null> } = {},
) {
  const memory = memoryConversationStore();
  const conversations: string[] = [];
  const toolsFor: AssistantToolsFor =
    options.toolsFor ??
    (async ({ conversationId }) => {
      conversations.push(conversationId);
      return [tool];
    });
  const runtime = createAssistantRuntime({
    store: memory.store,
    provider: {
      routeFor: () => SONNET,
      step: async (_task, input, stepOptions) => {
        const next = steps.shift();
        if (!next) throw new Error("no more steps");
        return next(input, stepOptions);
      },
    },
    toolsFor,
    ...(options.timeZoneOf ? { timeZoneOf: options.timeZoneOf } : {}),
    now: () => new Date("2026-11-23T20:00:00Z"),
  });
  return { runtime, memory, conversations };
}

/** A step that runs until it is aborted. */
const hangs: Step = async (_input, options) => {
  await new Promise((resolve) => options.abortSignal!.addEventListener("abort", resolve));
  return { ok: false, reason: "failed" };
};

async function start(runtime: ReturnType<typeof runtimeWith>["runtime"]) {
  const events: AssistantEvent[] = [];
  const run = await runtime.prepareTurn({ ...scope, question: "Which rooms?", requestId: "req-1" });
  if (!run) throw new Error("no access");
  const done = run((event) => events.push(event));
  // Until the turn has its conversation.
  await vi.waitFor(() => expect(events.some((event) => event.type === "turn")).toBe(true));
  const turn = events.find((event) => event.type === "turn");
  return { events, done, conversationId: turn?.type === "turn" ? turn.conversationId : "" };
}

describe("assistant runtime (VAY-2518)", () => {
  it("lets no one in who may not use the property, and stores nothing", async () => {
    const { runtime, memory } = runtimeWith([], { toolsFor: async () => undefined });
    expect(
      await runtime.prepareTurn({ ...scope, question: "Hello", requestId: "req-1" }),
    ).toBeUndefined();
    expect(await runtime.read(scope, "11111111-1111-4111-8111-111111111111")).toBe("forbidden");
    expect(await runtime.list(scope, { limit: 10 })).toBe("forbidden");
    expect(await runtime.stop(scope, "11111111-1111-4111-8111-111111111111")).toBe("forbidden");
    expect(memory.messages).toEqual([]);
  });

  it("sends today's date and the property with the question, marked as vayada's note", async () => {
    const seen: AiStepInput[] = [];
    const { runtime, conversations } = runtimeWith([
      async (input) => {
        seen.push(input);
        return answer("Two rooms.");
      },
    ]);
    const { done, conversationId } = await start(runtime);
    expect(await done).toMatchObject({ type: "end", status: "done" });
    expect(seen[0]!.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: `Note from vayada (not written by the person): today is Monday 2026-11-23 (UTC). This chat is about the property ${PROPERTY}.`,
          providerOptions: { vayada: { context: true } },
        },
        { type: "text", text: "Which rooms?" },
      ],
    });
    // A new chat's id is chosen first, so its tool calls are delegated for it from the start.
    expect(conversations[0]).toBe(conversationId);
  });

  it("dates the note in the hotel's own time zone", async () => {
    const seen: AiStepInput[] = [];
    const { runtime } = runtimeWith(
      [
        async (input) => {
          seen.push(input);
          return answer("Hello.");
        },
      ],
      { timeZoneOf: async () => "Asia/Colombo" },
    );
    const { done } = await start(runtime);
    await done;
    // 20:00 UTC on Monday is 01:30 on Tuesday in Colombo.
    expect(JSON.stringify(seen[0]!.messages[0])).toContain(
      "today is Tuesday 2026-11-24 (Asia/Colombo)",
    );
  });

  it("stops a turn running in this task at once", async () => {
    const { runtime } = runtimeWith([hangs]);
    const { done, conversationId } = await start(runtime);
    expect(await runtime.stop(scope, conversationId)).toBe(true);
    expect(await done).toEqual({ type: "end", status: "stopped", reason: "user_stopped" });
  });

  it("never stops another person's turn, nor a newer turn than the one the click meant", async () => {
    const { runtime } = runtimeWith([hangs]);
    const { done, conversationId, events } = await start(runtime);
    const otherUser = {
      ...scope,
      session: {
        ...session,
        actor: { internalUserId: "00000000-0000-4000-8000-000000000009" },
      } as unknown as RequestContext,
    };
    // Not running in this task for that person: the store is asked, and has nothing of theirs.
    expect(await runtime.stop(otherUser, conversationId)).toBe(false);
    expect(await runtime.stop(scope, conversationId, "00000000-0000-4000-8000-0000000000ee")).toBe(
      false,
    );
    const turn = events.find((event) => event.type === "turn");
    if (turn?.type !== "turn") throw new Error("no turn");
    expect(await runtime.stop(scope, conversationId, turn.turnId)).toBe(true);
    expect(await done).toMatchObject({ status: "stopped", reason: "user_stopped" });
  });

  it("asks the store to stop a turn that runs in another task", async () => {
    const { runtime, memory } = runtimeWith([]);
    const stopTurn = vi.spyOn(memory.store, "stopTurn").mockResolvedValue(true);
    expect(await runtime.stop(scope, "11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(stopTurn).toHaveBeenCalledWith(
      { organizationId: ORG, propertyId: PROPERTY, userId: USER, app: "pms" },
      "11111111-1111-4111-8111-111111111111",
      undefined,
    );
  });

  it("at shutdown lets a running turn finish within the grace, then cuts it as interrupted", async () => {
    const { runtime } = runtimeWith([hangs]);
    const { done } = await start(runtime);
    await runtime.drain(30);
    expect(await done).toEqual({ type: "end", status: "interrupted", reason: "shutdown" });
    // A question that arrives while the task is going down is turned away.
    const late = await runtime.prepareTurn({ ...scope, question: "Still there?", requestId: "r2" });
    const events: AssistantEvent[] = [];
    expect(await late!((event) => events.push(event))).toEqual({
      type: "refused",
      reason: "restarting",
    });
  });

  it("does not cut a turn that finishes within the grace", async () => {
    let release!: () => void;
    const { runtime } = runtimeWith([
      async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return answer("Done in time.");
      },
    ]);
    const { done } = await start(runtime);
    const draining = runtime.drain(5_000);
    release();
    await draining;
    expect(await done).toEqual({ type: "end", status: "done", reason: null });
  });

  it("reads and lists only the person's own chats, with the current request contract", async () => {
    const { runtime, memory } = runtimeWith([]);
    const read = vi.spyOn(memory.store, "read").mockResolvedValue(undefined);
    const list = vi.spyOn(memory.store, "list").mockResolvedValue([]);
    await runtime.read(scope, "11111111-1111-4111-8111-111111111111");
    await runtime.list(scope, { limit: 5 });
    const owner = { organizationId: ORG, propertyId: PROPERTY, userId: USER, app: "pms" };
    expect(read).toHaveBeenCalledWith(
      owner,
      "11111111-1111-4111-8111-111111111111",
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
    expect(list).toHaveBeenCalledWith(owner, read.mock.calls[0]![2], { limit: 5 });
  });
});
