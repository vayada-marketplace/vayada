import { describe, expect, it, vi } from "vitest";

import type {
  AiCallRecord,
  AiStepInput,
  AiStepOptions,
  AiStepResult,
} from "../provider/aiProvider.js";
import type { ModelRoute } from "../provider/catalog.js";
import {
  runAssistantTurn,
  type AssistantEvent,
  type AssistantTool,
  type AssistantTurnInput,
  type ToolOutcome,
} from "./assistantTurn.js";
import type { ChatMessage, ConversationOwner } from "./conversationStore.js";
import { memoryConversationStore } from "./memoryConversationStore.fixtures.js";
import { requestContract } from "./requestContract.js";

/** VAY-2518: the in-app assistant's loop, with a scripted model and an in-memory store. */
const SONNET: ModelRoute = {
  provider: "bedrock",
  region: "eu-west-1",
  model: "eu.anthropic.claude-sonnet-5-5",
};
const OWNER: ConversationOwner = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  propertyId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
  app: "pms",
};
const INSTRUCTIONS = "You are vayada's assistant for hotel staff.";
const RECORD: AiCallRecord = {
  route: SONNET,
  usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20 },
  costMicroUsd: 1,
  priceTableVersion: "2026-11-20",
  latencyMs: 5,
};

type Step = AiStepResult | ((input: AiStepInput, options: AiStepOptions) => Promise<AiStepResult>);

const answer = (text: string): AiStepResult => ({
  ok: true,
  finishReason: "stop",
  messages: [{ role: "assistant", content: [{ type: "text", text }] }],
  ...RECORD,
});
const asks = (...calls: [string, string, unknown][]): AiStepResult => ({
  ok: true,
  finishReason: "tool-calls",
  messages: [
    {
      role: "assistant",
      content: calls.map(([toolCallId, toolName, input]) => ({
        type: "tool-call",
        toolCallId,
        toolName,
        input,
      })),
    },
  ],
  ...RECORD,
});

function rooms(run?: (input: unknown) => Promise<ToolOutcome>) {
  return {
    definition: {
      name: "rooms_list",
      description: "Lists the property's rooms.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
    run: vi.fn<AssistantTool["run"]>(
      run ?? (async () => ({ ok: true, data: { rooms: ["Deluxe"] } })),
    ),
  };
}

function scripted(steps: Step[], route: ModelRoute | null = SONNET) {
  const inputs: AiStepInput[] = [];
  return {
    inputs,
    provider: {
      routeFor: () => route ?? undefined,
      async step(_task: string, input: AiStepInput, options: AiStepOptions) {
        inputs.push({ ...input, messages: [...input.messages] });
        const next = steps.shift();
        if (!next) throw new Error("the loop asked for one step too many");
        return typeof next === "function" ? next(input, options) : next;
      },
    } as AssistantTurnInput["provider"],
  };
}

async function turn(
  steps: Step[],
  {
    memory = memoryConversationStore(),
    ...extra
  }: Partial<AssistantTurnInput> & { memory?: ReturnType<typeof memoryConversationStore> } = {},
) {
  const model = scripted(steps);
  const events: AssistantEvent[] = [];
  const tool = rooms();
  const end = await runAssistantTurn({
    store: memory.store,
    provider: model.provider,
    owner: OWNER,
    question: "Which rooms do we have?",
    instructions: INSTRUCTIONS,
    tools: [tool],
    requestId: "req-1",
    emit: (event) => events.push(event),
    ...extra,
  });
  return { end, events, memory, model, tool };
}

const resultsOf = (messages: ChatMessage[]) =>
  messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.content as { toolCallId: string; output: unknown }[]);

describe("assistant turn (VAY-2518)", () => {
  it("answers in one step: the text streams to the panel, question and answer are stored", async () => {
    const { end, events, memory, model, tool } = await turn([
      async (_input, options) => {
        options.onTextDelta?.("You have ");
        options.onTextDelta?.("one room: Deluxe.");
        return answer("You have one room: Deluxe.");
      },
    ]);
    expect(end).toEqual({ type: "end", status: "done", reason: null });
    expect(events).toEqual([
      {
        type: "turn",
        conversationId: "11111111-1111-4111-8111-111111111111",
        turnId: "22222222-2222-4222-8222-222222222222",
      },
      { type: "text", text: "You have " },
      { type: "text", text: "one room: Deluxe." },
      end,
    ]);
    expect(memory.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(memory.ends).toEqual([{ status: "done" }]);
    // The chat is tied to the requests it is made of: route, prompt and tools.
    expect(memory.contracts).toEqual([
      requestContract({ route: SONNET, systemPrompt: INSTRUCTIONS, tools: [tool.definition] })
        .sha256,
    ]);
    expect(model.inputs[0]).toEqual({
      instructions: INSTRUCTIONS,
      messages: [{ role: "user", content: "Which rooms do we have?" }],
      tools: [tool.definition],
    });
  });

  it("runs the tools the model asks for, stores their results and goes on with them", async () => {
    const { end, events, memory, model, tool } = await turn([
      asks(["toolu_1", "rooms_list", { propertyId: "p1" }]),
      answer("You have Deluxe."),
    ]);
    expect(end).toMatchObject({ status: "done" });
    expect(tool.run).toHaveBeenCalledWith(
      { propertyId: "p1" },
      expect.objectContaining({ toolCallId: "toolu_1" }),
    );
    expect(events.filter((event) => event.type === "tool")).toEqual([
      { type: "tool", toolCallId: "toolu_1", name: "rooms_list", status: "running" },
      { type: "tool", toolCallId: "toolu_1", name: "rooms_list", status: "ok" },
    ]);
    expect(memory.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(resultsOf(memory.messages)).toEqual([
      {
        type: "tool-result",
        toolCallId: "toolu_1",
        toolName: "rooms_list",
        output: { type: "json", value: { rooms: ["Deluxe"] } },
      },
    ]);
    // The second step sees everything stored so far, in order.
    expect(model.inputs[1]!.messages).toEqual(memory.messages.slice(0, 3));
  });

  it("answers a failed tool, an unknown tool and a third identical call with an error", async () => {
    const memory = memoryConversationStore();
    const tool = rooms(async (input) =>
      (input as { propertyId?: string }).propertyId === "p9"
        ? { ok: false, error: { code: "not_allowed", message: "You do not have access to this." } }
        : { ok: true, data: { rooms: [] } },
    );
    const events: AssistantEvent[] = [];
    await runAssistantTurn({
      store: memory.store,
      provider: scripted([
        asks(["toolu_1", "rooms_list", { propertyId: "p1" }], ["toolu_2", "delete_hotel", {}]),
        asks(
          ["toolu_3", "rooms_list", { propertyId: "p1" }],
          ["toolu_4", "rooms_list", { propertyId: "p9" }],
        ),
        asks(["toolu_5", "rooms_list", { propertyId: "p1" }]),
        answer("Done."),
      ]).provider,
      owner: OWNER,
      question: "Rooms?",
      instructions: INSTRUCTIONS,
      tools: [tool],
      requestId: "req-1",
      emit: (event) => events.push(event),
    });
    // toolu_1, toolu_3 and toolu_4 ran; the unknown tool and the third identical call did not.
    expect(tool.run.mock.calls.map(([, call]) => call.toolCallId)).toEqual([
      "toolu_1",
      "toolu_3",
      "toolu_4",
    ]);
    const outputs = Object.fromEntries(
      resultsOf(memory.messages).map((part) => [part.toolCallId, part.output]),
    );
    expect(outputs["toolu_2"]).toEqual({
      type: "error-json",
      value: { code: "unknown_tool", message: "There is no tool with this name." },
    });
    expect(outputs["toolu_4"]).toEqual({
      type: "error-json",
      value: { code: "not_allowed", message: "You do not have access to this." },
    });
    expect(outputs["toolu_5"]).toMatchObject({
      type: "error-json",
      value: { code: "repeat_limit" },
    });
    expect(events).toContainEqual({
      type: "tool",
      toolCallId: "toolu_4",
      name: "rooms_list",
      status: "failed",
    });
  });

  it("a tool that throws gives the model a plain error, never the error's text", async () => {
    const memory = memoryConversationStore();
    const tool = rooms(async () => {
      throw new Error("relation pms.rooms: Maria Schmidt +49 170 1234567");
    });
    await runAssistantTurn({
      store: memory.store,
      provider: scripted([asks(["toolu_1", "rooms_list", {}]), answer("Sorry.")]).provider,
      owner: OWNER,
      question: "Rooms?",
      instructions: INSTRUCTIONS,
      tools: [tool],
      requestId: "req-1",
      emit: () => undefined,
    });
    expect(JSON.stringify(memory.messages)).not.toContain("Maria");
    expect(resultsOf(memory.messages)[0]!.output).toEqual({
      type: "error-json",
      value: { code: "failed", message: "The request did not succeed." },
    });
  });

  it("stops at the step limit, and every call it made has its result", async () => {
    const { end, memory, model } = await turn(
      [asks(["toolu_1", "rooms_list", { n: 1 }]), asks(["toolu_2", "rooms_list", { n: 2 }])],
      { limits: { steps: 2 } },
    );
    expect(end).toEqual({ type: "end", status: "stopped", reason: "step_limit" });
    expect(model.inputs).toHaveLength(2);
    expect(resultsOf(memory.messages)).toHaveLength(2);
  });

  it("stops at the time limit and at the token limit", async () => {
    let clock = 0;
    const slow = await turn(
      [
        async () => {
          clock += 200_000;
          return asks(["toolu_1", "rooms_list", {}]);
        },
      ],
      { now: () => clock },
    );
    expect(slow.end).toMatchObject({ status: "stopped", reason: "time_limit" });
    // The step came back after the turn's time was up: its tool did not run.
    expect(slow.tool.run).not.toHaveBeenCalled();
    expect(resultsOf(slow.memory.messages)[0]!.output).toMatchObject({
      type: "error-json",
      value: { code: "not_run" },
    });

    const costly = await turn([asks(["toolu_1", "rooms_list", {}])], { limits: { tokens: 100 } });
    expect(costly.end).toMatchObject({ status: "stopped", reason: "token_limit" });
  });

  it("ends the turn when a change waits for the user's Yes, and asks the model nothing more", async () => {
    const memory = memoryConversationStore();
    const ask: AssistantTool = {
      definition: {
        name: "room_block_create",
        description: "Blocks a room.",
        inputSchema: {},
        outputSchema: {},
      },
      run: async () => ({
        ok: true,
        data: {
          status: "waiting_for_answer",
          pendingActionId: "33333333-3333-4333-8333-333333333333",
        },
        waitsForAnswer: true,
      }),
    };
    const model = scripted([
      asks(
        ["toolu_1", "room_block_create", { roomId: "r1" }],
        ["toolu_2", "room_block_create", { roomId: "r2" }],
      ),
    ]);
    const end = await runAssistantTurn({
      store: memory.store,
      provider: model.provider,
      owner: OWNER,
      question: "Block room 101 tonight",
      instructions: INSTRUCTIONS,
      tools: [ask],
      requestId: "req-1",
      emit: () => undefined,
    });
    expect(end).toEqual({ type: "end", status: "waiting_for_answer", reason: null });
    expect(model.inputs).toHaveLength(1);
    // One change waits for the user; the second one in the same step is not even asked.
    expect(resultsOf(memory.messages).map((part) => part.output)).toEqual([
      {
        type: "json",
        value: {
          status: "waiting_for_answer",
          pendingActionId: "33333333-3333-4333-8333-333333333333",
        },
      },
      {
        type: "error-json",
        value: {
          code: "not_run",
          message: "A change is waiting for the user's answer: ask again after it.",
        },
      },
    ]);
  });

  it.each<[AiStepResult, string, string]>([
    [{ ok: false, reason: "allowance_used_up" }, "failed", "allowance_used_up"],
    [{ ok: false, reason: "busy" }, "failed", "busy"],
    [{ ok: false, reason: "failed" }, "failed", "provider_error"],
    [{ ok: false, reason: "refused", ...RECORD }, "stopped", "refused"],
    [{ ok: false, reason: "truncated", ...RECORD }, "stopped", "output_limit"],
  ])(
    "a step without an answer (%o) ends the turn and stores nothing of it",
    async (step, status, reason) => {
      const { end, memory } = await turn([step]);
      expect(end).toEqual({ type: "end", status, reason });
      expect(memory.messages.map((message) => message.role)).toEqual(["user"]);
    },
  );

  it("stores nothing while AI is off, and passes on why a chat can't take the question", async () => {
    const memory = memoryConversationStore();
    const events: AssistantEvent[] = [];
    const off = await runAssistantTurn({
      store: memory.store,
      provider: scripted([], null).provider,
      owner: OWNER,
      question: "Hello?",
      instructions: INSTRUCTIONS,
      tools: [],
      requestId: "req-1",
      emit: (event) => events.push(event),
    });
    expect(off).toEqual({ type: "refused", reason: "unavailable" });
    expect(events).toEqual([off]);
    expect(memory.contracts).toEqual([]);

    for (const [start, refused] of [
      [{ status: "busy" }, { type: "refused", reason: "busy" }],
      [{ status: "not_found" }, { type: "refused", reason: "not_found" }],
      [
        { status: "read_only", reason: "contract_changed" },
        { type: "refused", reason: "read_only", readOnlyReason: "contract_changed" },
      ],
    ] as const) {
      const { end, model } = await turn([], { memory: memoryConversationStore({ start }) });
      expect(end).toEqual(refused);
      expect(model.inputs).toHaveLength(0);
    }
  });

  it("starts no new step once the API is shutting down", async () => {
    let shuttingDown = false;
    const { end, model } = await turn(
      [
        async () => {
          shuttingDown = true;
          return asks(["toolu_1", "rooms_list", {}]);
        },
      ],
      { shuttingDown: () => shuttingDown },
    );
    expect(end).toEqual({ type: "end", status: "interrupted", reason: "shutdown" });
    expect(model.inputs).toHaveLength(1);
  });

  it("starts no tool once the API is shutting down: a closing server answers no route", async () => {
    let shuttingDown = false;
    const { end, tool, memory } = await turn(
      [
        async () => {
          shuttingDown = true;
          return asks(["toolu_1", "rooms_list", {}]);
        },
      ],
      { shuttingDown: () => shuttingDown },
    );
    expect(end).toMatchObject({ status: "interrupted", reason: "shutdown" });
    expect(tool.run).not.toHaveBeenCalled();
    expect(resultsOf(memory.messages)[0]!.output).toEqual({
      type: "error-json",
      value: {
        code: "not_run",
        message: "The server restarted before this ran. Ask again in a moment.",
      },
    });
  });

  it("the user's Stop ends the step and the turn", async () => {
    const stop = new AbortController();
    const { end } = await turn(
      [
        async (_input, options) => {
          stop.abort();
          expect(options.abortSignal?.aborted).toBe(true);
          return { ok: false, reason: "failed" };
        },
      ],
      { signal: stop.signal },
    );
    expect(end).toEqual({ type: "end", status: "stopped", reason: "user_stopped" });
  });

  it("replaces a tool answer too large to store with an error asking for less", async () => {
    const big = rooms(async () => ({ ok: true, data: { rows: "x".repeat(70_000) } }));
    const memory = memoryConversationStore();
    await runAssistantTurn({
      store: memory.store,
      provider: scripted([
        asks(["toolu_1", "rooms_list", { a: 1 }], ["toolu_2", "rooms_list", { a: 2 }]),
        answer("Too much."),
      ]).provider,
      owner: OWNER,
      question: "Everything?",
      instructions: INSTRUCTIONS,
      tools: [big],
      requestId: "req-1",
      emit: () => undefined,
    });
    // One stored message per result, each within the store's limit.
    expect(memory.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(resultsOf(memory.messages).map((part) => part.output)).toEqual([
      expect.objectContaining({
        type: "error-json",
        value: expect.objectContaining({ code: "too_large" }),
      }),
      expect.objectContaining({
        type: "error-json",
        value: expect.objectContaining({ code: "too_large" }),
      }),
    ]);
  });

  it("ends the turn as failed when storing goes wrong, and logs only the error's name", async () => {
    const memory = memoryConversationStore();
    const append = memory.store.append;
    memory.store.append = async () => {
      throw new Error("connection to server lost while storing Maria Schmidt");
    };
    const log = { warn: vi.fn() };
    const events: AssistantEvent[] = [];
    const end = await runAssistantTurn({
      store: memory.store,
      provider: scripted([answer("Hello.")]).provider,
      owner: OWNER,
      question: "Hi",
      instructions: INSTRUCTIONS,
      tools: [],
      requestId: "req-1",
      emit: (event) => events.push(event),
      log,
    });
    memory.store.append = append;
    expect(end).toEqual({ type: "end", status: "failed", reason: "internal_error" });
    expect(events.at(-1)).toEqual(end);
    expect(memory.ends).toEqual([{ status: "failed", reason: "internal_error" }]);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("Maria");
    expect(log.warn).toHaveBeenCalledWith(
      { requestId: "req-1", error: "Error" },
      "Assistant turn failed",
    );
  });

  it("stops at once when the store closed the turn after a missed heartbeat", async () => {
    const memory = memoryConversationStore();
    const { end } = await turn(
      [
        async (_input, options) => {
          memory.closeElsewhere();
          await new Promise((resolve) => options.abortSignal!.addEventListener("abort", resolve));
          return { ok: false, reason: "failed" };
        },
      ],
      { memory, heartbeatMs: 5 },
    );
    expect(end).toEqual({ type: "end", status: "interrupted", reason: "closed_elsewhere" });
    expect(memory.ends).toEqual([]);
  });
});
