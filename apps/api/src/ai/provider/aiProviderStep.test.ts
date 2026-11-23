import { describe, expect, it, vi } from "vitest";

import {
  createAiProvider,
  type AiBudget,
  type AiMessage,
  type AiReservationRequest,
  type AiSettlement,
  type AiStepInput,
  type AiStepOptions,
} from "./aiProvider.js";
import {
  bedrockStream,
  claudeReply,
  type ReplyBlock,
  type ReplyUsage,
} from "./bedrockStream.fixtures.js";
import type { ModelRoute } from "./catalog.js";

/**
 * VAY-2518: one streamed step of the in-app assistant, through the real Bedrock provider with
 * only the network faked. No model is called.
 */
const SONNET: ModelRoute = {
  provider: "bedrock",
  region: "eu-west-1",
  model: "eu.anthropic.claude-sonnet-5-5",
};
const CREDENTIALS = async () => ({ accessKeyId: "AKIAFAKEFAKEFAKEFAKE", secretAccessKey: "fake" });
const OPTIONS: AiStepOptions = {
  context: {
    organizationId: "00000000-0000-4000-8000-000000000001",
    propertyId: "00000000-0000-4000-8000-000000000002",
    userId: "00000000-0000-4000-8000-000000000003",
    surface: "assistant",
    requestId: "req-step",
  },
};
const schema = {
  type: "object",
  properties: { propertyId: { type: "string" } },
  required: ["propertyId"],
  additionalProperties: false,
};
// Not in name order: the SDK would sort them, and the order is part of the cached prefix.
const TOOLS = [
  { name: "rooms_list", description: "Lists the property's rooms.", inputSchema: schema },
  { name: "calendar_days", description: "Reads calendar days.", inputSchema: schema },
];
const INSTRUCTIONS = "You are vayada's assistant for hotel staff.";
const QUESTION = "Which rooms do we have?";
const INPUT: AiStepInput = {
  instructions: INSTRUCTIONS,
  messages: [{ role: "user", content: QUESTION }],
  tools: TOOLS,
};
const USAGE: ReplyUsage = {
  input_tokens: 1_000,
  cache_read_input_tokens: 3_000,
  cache_creation_input_tokens: 200,
  output_tokens: 50,
};
// Within what the small test prompt can count (a token always covers at least one byte).
const SMALL: ReplyUsage = {
  input_tokens: 100,
  cache_read_input_tokens: 300,
  cache_creation_input_tokens: 20,
  output_tokens: 5,
};
/** SMALL's input plus the whole 16,000-token output limit, in micro-dollars. */
const SMALL_AT_MOST = 176_341; // 100 x 2,200 + 300 x 110 + 20 x 4,400 + 16,000 x 11,000 nano
const BREAKPOINT = { type: "ephemeral", ttl: "1h" };

type Body = {
  max_tokens?: number;
  system?: { text?: string; cache_control?: unknown }[];
  tools?: { name: string; cache_control?: unknown }[];
  tool_choice?: { type?: string };
  messages: { role: string; content: Record<string, unknown>[] }[];
  thread?: unknown;
};

function setup(
  replies: ((init?: RequestInit) => Response)[],
  overrides: Partial<Parameters<typeof createAiProvider>[0]> = {},
) {
  const calls: { url: string; body: Body }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Body });
    const reply = replies.shift();
    if (!reply) throw new Error("no more replies");
    return reply(init);
  });
  const reservations: AiReservationRequest[] = [];
  const settlements: [string, AiSettlement][] = [];
  const budget: AiBudget = {
    async reserve(request) {
      reservations.push(request);
      return { ok: true, reservationId: `res-${reservations.length}` };
    },
    async settle(reservationId, settlement) {
      settlements.push([reservationId, settlement]);
    },
  };
  const log = { warn: vi.fn() };
  let clock = 0;
  const provider = createAiProvider({
    enabledProviders: ["bedrock"],
    budget,
    fetch: fetch as unknown as typeof globalThis.fetch,
    awsCredentials: CREDENTIALS,
    log,
    now: () => (clock += 100),
    ...overrides,
  });
  return { provider, calls, reservations, settlements, log };
}

const reply =
  (blocks: ReplyBlock[], usage = USAGE, stop?: string) =>
  () =>
    bedrockStream(claudeReply(blocks, usage, stop));

/** The request without its cache markers: what the prompt cache compares. */
function withoutMarkers(body: Body) {
  return JSON.parse(
    JSON.stringify(body, (key, value: unknown) => (key === "cache_control" ? undefined : value)),
  ) as Body;
}

describe("AI provider step (VAY-2518)", () => {
  it("streams a step: the answer text as it arrives, the message to keep, its tokens and cost", async () => {
    const { provider, calls, reservations, settlements } = setup([
      reply([
        { type: "thinking", thinking: "They want the room list.", signature: "sig-1" },
        { type: "text", text: "You have two rooms." },
      ]),
    ]);
    const deltas: string[] = [];
    const result = await provider.step("assistant_chat", INPUT, {
      ...OPTIONS,
      onTextDelta: (text) => deltas.push(text),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://bedrock-runtime.eu-west-1.amazonaws.com/model/eu.anthropic.claude-sonnet-5-5/invoke-with-response-stream",
    );
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("You have two rooms.");
    expect(result).toMatchObject({
      ok: true,
      finishReason: "stop",
      route: SONNET,
      usage: {
        inputTokens: 1_000,
        cacheReadTokens: 3_000,
        cacheWriteTokens: 200,
        outputTokens: 50,
      },
      // 1,000 x 2,200 + 3,000 x 110 + 200 x 4,400 + 50 x 11,000 nano-dollars
      costMicroUsd: 3_960,
    });
    if (!result.ok) throw new Error("expected an answer");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("assistant");
    // Besides these, the provider keeps its own message details (a "custom" part): kept as is.
    expect(result.messages[0]!.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "reasoning", text: "They want the room list." }),
        { type: "text", text: "You have two rooms." },
      ]),
    );
    // The signature Claude needs to accept the thinking when it is sent back.
    expect(JSON.stringify(result.messages[0])).toContain("sig-1");
    expect(reservations).toMatchObject([
      { task: "assistant_chat", route: SONNET, holdMs: 135_000 },
    ]);
    expect(settlements).toEqual([
      [
        "res-1",
        {
          status: "completed",
          costMicroUsd: 3_960,
          usage: {
            inputTokens: 1_000,
            cacheReadTokens: 3_000,
            cacheWriteTokens: 200,
            outputTokens: 50,
          },
        },
      ],
    ]);
  });

  it("hands tool calls back without running them", async () => {
    const { provider } = setup([
      reply([
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "toolu_01", name: "rooms_list", input: { propertyId: "p1" } },
      ]),
    ]);
    const result = await provider.step("assistant_chat", INPUT, OPTIONS);
    if (!result.ok) throw new Error(`expected a step, got ${result.reason}`);
    expect(result.finishReason).toBe("tool-calls");
    // Only the model's message: no tool result, because nothing ran.
    expect(result.messages.map((message) => message.role)).toEqual(["assistant"]);
    expect(result.messages[0]!.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-call",
          toolCallId: "toolu_01",
          toolName: "rooms_list",
          input: { propertyId: "p1" },
        }),
      ]),
    );
  });

  it("sends the tools in their order and the history unchanged, cached up to the last message", async () => {
    const { provider, calls } = setup([
      reply([
        { type: "tool_use", id: "toolu_02", name: "rooms_list", input: { propertyId: "p1" } },
      ]),
      reply([{ type: "text", text: "Deluxe and Suite." }]),
    ]);
    const first = await provider.step("assistant_chat", INPUT, OPTIONS);
    if (!first.ok) throw new Error(first.reason);
    const toolResult: AiMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "toolu_02",
          toolName: "rooms_list",
          output: { type: "json", value: { rooms: ["Deluxe", "Suite"] } },
        },
      ],
    };
    const second = await provider.step(
      "assistant_chat",
      { ...INPUT, messages: [...INPUT.messages, ...first.messages, toolResult] },
      OPTIONS,
    );
    expect(second).toMatchObject({ ok: true, finishReason: "stop" });

    for (const { body } of calls) {
      expect(body.tools?.map((tool) => tool.name)).toEqual(["rooms_list", "calendar_days"]);
      expect(body.tool_choice?.type ?? "auto").toBe("auto");
      expect(body.max_tokens).toBe(16_000);
      expect(body).not.toHaveProperty("thread");
      // Breakpoint 1: after the tools and the system prompt.
      expect(body.system).toEqual([
        { type: "text", text: INSTRUCTIONS, cache_control: BREAKPOINT },
      ]);
      // In the history: the last block of the last message...
      const last = body.messages.at(-1)!.content.at(-1)!;
      expect(last["cache_control"]).toEqual(BREAKPOINT);
    }
    // ...and, once there is an answer, the last message of the request before it, where that
    // request's cache entry ends; nowhere else.
    const markers = (body: Body) =>
      JSON.stringify(body.messages).split('"cache_control"').length - 1;
    expect(calls.map((call) => markers(call.body))).toEqual([1, 2]);
    expect(calls[1]!.body.messages[0]!.content.at(-1)!["cache_control"]).toEqual(BREAKPOINT);
    // The second request repeats the first one's prompt byte for byte, so it can read it from
    // the cache (the markers themselves are not part of the cached prefix).
    const [one, two] = calls.map((call) => withoutMarkers(call.body));
    expect(JSON.stringify(two!.tools)).toBe(JSON.stringify(one!.tools));
    expect(JSON.stringify(two!.system)).toBe(JSON.stringify(one!.system));
    expect(JSON.stringify(two!.messages.slice(0, one!.messages.length))).toBe(
      JSON.stringify(one!.messages),
    );
  });

  it("sends signed thinking back exactly as it came", async () => {
    const { provider, calls } = setup([
      reply([
        { type: "thinking", thinking: "Check the rooms first.", signature: "sig-thinking-1" },
        { type: "tool_use", id: "toolu_03", name: "rooms_list", input: { propertyId: "p1" } },
      ]),
      reply([{ type: "text", text: "Done." }]),
    ]);
    const first = await provider.step("assistant_chat", INPUT, OPTIONS);
    if (!first.ok) throw new Error(first.reason);
    // Stored as JSON and read back, as the conversation store does.
    const stored = JSON.parse(JSON.stringify(first.messages)) as AiMessage[];
    const toolResult: AiMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "toolu_03",
          toolName: "rooms_list",
          output: { type: "json", value: { rooms: [] } },
        },
      ],
    };
    await provider.step(
      "assistant_chat",
      { ...INPUT, messages: [...INPUT.messages, ...stored, toolResult] },
      OPTIONS,
    );
    const assistant = calls[1]!.body.messages.find((message) => message.role === "assistant")!;
    expect(assistant.content[0]).toMatchObject({
      type: "thinking",
      thinking: "Check the rooms first.",
      signature: "sig-thinking-1",
    });
  });

  it.each([
    ["refusal", "refused"],
    ["max_tokens", "truncated"],
  ])("bills a %s but keeps nothing of it", async (stopReason, reason) => {
    const { provider, settlements } = setup([
      reply([{ type: "text", text: "I can't" }], USAGE, stopReason),
    ]);
    const result = await provider.step("assistant_chat", INPUT, OPTIONS);
    expect(result).toMatchObject({ ok: false, reason, costMicroUsd: 3_960 });
    expect(result).not.toHaveProperty("messages");
    expect(settlements[0]![1]).toMatchObject({ status: "completed", costMicroUsd: 3_960 });
  });

  it("fails a stream that breaks, charges the input Claude counted and logs no prompt text", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = () => {
      const good = bedrockStream(claudeReply([{ type: "text", text: "Half an answer" }], SMALL));
      const reader = good.body!.getReader();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const first = await reader.read();
          if (first.value) controller.enqueue(first.value);
          // The connection breaks a moment after the answer started.
          await new Promise((resolve) => setTimeout(resolve, 20));
          controller.error(new Error(`connection reset while sending ${QUESTION}`));
        },
      });
      return new Response(body, { status: 200, headers: good.headers });
    };
    const { provider, reservations, settlements, log } = setup([broken]);
    const result = await provider.step("assistant_chat", INPUT, OPTIONS);
    expect(result).toEqual({ ok: false, reason: "failed" });
    // Claude had counted the input when the stream broke: that, plus at most the output limit.
    expect(settlements).toEqual([["res-1", { status: "failed", costMicroUsd: SMALL_AT_MOST }]]);
    expect(SMALL_AT_MOST).toBeLessThan(reservations[0]!.reservedMicroUsd);
    const logged = JSON.stringify(log.warn.mock.calls);
    expect(logged).toContain("AI provider step failed");
    for (const text of [QUESTION, INSTRUCTIONS, "Half an answer"])
      expect(logged).not.toContain(text);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("keeps the full reservation when the connection broke before Claude counted anything", async () => {
    const { provider, reservations, settlements } = setup([
      () => {
        throw new TypeError("fetch failed: connection reset");
      },
    ]);
    expect(await provider.step("assistant_chat", INPUT, OPTIONS)).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(settlements).toEqual([
      ["res-1", { status: "failed", costMicroUsd: reservations[0]!.reservedMicroUsd }],
    ]);
  });

  it("stops a streaming step when the user presses Stop, and charges the input Claude counted", async () => {
    const stop = new AbortController();
    const { provider, settlements } = setup([
      (init) =>
        bedrockStream(claudeReply([{ type: "text", text: "A long answer" }], SMALL).slice(0, 3), {
          openUntil: init?.signal ?? null,
        }),
    ]);
    const deltas: string[] = [];
    const result = await provider.step("assistant_chat", INPUT, {
      ...OPTIONS,
      abortSignal: stop.signal,
      onTextDelta: (text) => {
        deltas.push(text);
        stop.abort();
      },
    });
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(deltas).toEqual(["A long "]);
    expect(settlements).toEqual([["res-1", { status: "failed", costMicroUsd: SMALL_AT_MOST }]]);
  });

  it("answers a call to a tool that doesn't exist itself, so the loop has nothing to run", async () => {
    const { provider } = setup([
      reply([{ type: "tool_use", id: "toolu_09", name: "delete_hotel", input: {} }]),
    ]);
    const result = await provider.step("assistant_chat", INPUT, OPTIONS);
    if (!result.ok) throw new Error(result.reason);
    const answered = result.messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content as { toolCallId?: string }[])
      .map((part) => part.toolCallId);
    expect(answered).toEqual(["toolu_09"]);
  });

  it("sends nothing once the caller has stopped, and charges nothing", async () => {
    const { provider, calls, settlements } = setup([reply([{ type: "text", text: "Hi" }])]);
    const stopped = new AbortController();
    stopped.abort();
    const result = await provider.step("assistant_chat", INPUT, {
      ...OPTIONS,
      abortSignal: stopped.signal,
    });
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(calls).toHaveLength(0);
    expect(settlements).toEqual([["res-1", { status: "failed", costMicroUsd: 0 }]]);
  });

  it("names the assistant's route only while a cleared provider is on, and calls nothing otherwise", async () => {
    const on = setup([]);
    expect(on.provider.routeFor("assistant_chat")).toEqual(SONNET);

    const off = setup([], { enabledProviders: [] });
    expect(off.provider.routeFor("assistant_chat")).toBeUndefined();
    expect(await off.provider.step("assistant_chat", INPUT, OPTIONS)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(off.calls).toHaveLength(0);
    expect(off.reservations).toHaveLength(0);
  });
});
