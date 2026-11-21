import { registerTelemetry } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAiProvider,
  enabledAiProvidersFromEnv,
  type AiBudget,
  type AiReservation,
  type AiReservationRequest,
  type AiRunOptions,
  type AiSettlement,
} from "./aiProvider.js";
import { TASK_SETTINGS, costMicroUsd, maxCostMicroUsd, type ModelRoute } from "./catalog.js";

const HAIKU: ModelRoute = {
  provider: "bedrock",
  region: "eu-west-1",
  model: "eu.anthropic.claude-haiku-5-5",
};
const OPTIONS: AiRunOptions = {
  context: {
    organizationId: "00000000-0000-4000-8000-000000000001",
    propertyId: "00000000-0000-4000-8000-000000000002",
    userId: "00000000-0000-4000-8000-000000000003",
    surface: "inbox",
    requestId: "req-1",
  },
};
const INPUT = {
  instructions: "Translate the guest message into English.",
  messages: [{ role: "user" as const, content: "Guten Morgen, ist das Zimmer frei?" }],
};
const CREDENTIALS = async () => ({ accessKeyId: "AKIAFAKEFAKEFAKEFAKE", secretAccessKey: "fake" });

type Call = { url: string; headers: Headers; body: Record<string, unknown> };

/** Stands in for the PostgreSQL budget (ai/usage, tested against a real database there). */
function fakeBudget(answer: AiReservation | Error = { ok: true, reservationId: "res-1" }) {
  const reservations: AiReservationRequest[] = [];
  const settlements: [string, AiSettlement][] = [];
  const budget: AiBudget = {
    async reserve(request) {
      reservations.push(request);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async settle(reservationId, settlement) {
      settlements.push([reservationId, settlement]);
    },
  };
  return { budget, reservations, settlements };
}

function anthropicReply(text: string, usage: Record<string, number>, stopReason = "end_turn") {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: text ? [{ type: "text", text }] : [],
      stop_reason: stopReason,
      stop_sequence: null,
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    calls.push(call);
    return respond(call);
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createAiProvider", () => {
  it("calls Claude on Bedrock in the EU with signed requests and returns text, tokens and cost", async () => {
    // Both would move the call elsewhere if the provider read them (research 09c a).
    vi.stubEnv(
      "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
      "https://bedrock-runtime.us-east-1.amazonaws.com",
    );
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "bearer-from-env");
    const network = fakeFetch(() =>
      anthropicReply("Good morning, is the room free?", {
        input_tokens: 1_000,
        cache_read_input_tokens: 2_000,
        cache_creation_input_tokens: 500,
        output_tokens: 300,
      }),
    );
    let clock = 1_000;
    const ledger = fakeBudget();
    const provider = createAiProvider({
      enabledProviders: ["bedrock"],
      budget: ledger.budget,
      fetch: network.fetch,
      awsCredentials: CREDENTIALS,
      now: () => (clock += 250),
    });

    const result = await provider.run("inbox_translate", INPUT, OPTIONS);

    expect(network.calls).toHaveLength(1);
    const [call] = network.calls;
    expect(call!.url).toBe(
      "https://bedrock-runtime.eu-west-1.amazonaws.com/model/eu.anthropic.claude-haiku-5-5/invoke",
    );
    expect(call!.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAFAKEFAKEFAKEFAKE\/\d{8}\/eu-west-1\/bedrock\//,
    );
    expect(call!.body).toMatchObject({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: TASK_SETTINGS.inbox_translate.maxOutputTokens,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: [{ type: "text", text: INPUT.messages[0]!.content }] }],
    });
    expect(JSON.stringify(call!.body.system)).toContain(INPUT.instructions);
    expect(call!.body).not.toHaveProperty("model");
    expect(result).toEqual({
      ok: true,
      text: "Good morning, is the room free?",
      route: HAIKU,
      usage: {
        inputTokens: 1_000,
        cacheReadTokens: 2_000,
        cacheWriteTokens: 500,
        outputTokens: 300,
      },
      // 1,000 x 110 + 2,000 x 11 + 500 x 220 + 300 x 550 nano-dollars
      costMicroUsd: 407,
      priceTableVersion: "2026-11-20",
      latencyMs: 250,
    });
    expect(ledger.reservations).toEqual([
      {
        task: "inbox_translate",
        context: OPTIONS.context,
        route: HAIKU,
        priceTableVersion: "2026-11-20",
        // (41 + 34 bytes + 2 x 64) x 220 + 4,096 x 550 nano-dollars: every byte a cache-write token
        reservedMicroUsd: 2_298,
        holdMs: 60_000,
      },
    ]);
    expect(ledger.settlements).toEqual([
      [
        "res-1",
        {
          status: "completed",
          costMicroUsd: 407,
          usage: {
            inputTokens: 1_000,
            cacheReadTokens: 2_000,
            cacheWriteTokens: 500,
            outputTokens: 300,
          },
        },
      ],
    ]);
  });

  it("calls no model when the account's AI budget is spent or its calls are already running", async () => {
    const network = fakeFetch(() => anthropicReply("x", { input_tokens: 1, output_tokens: 1 }));
    for (const reason of ["allowance_used_up", "busy"] as const) {
      const ledger = fakeBudget({ ok: false, reason });
      const provider = createAiProvider({
        enabledProviders: ["bedrock"],
        budget: ledger.budget,
        fetch: network.fetch,
        awsCredentials: CREDENTIALS,
      });

      expect(await provider.run("inbox_draft", INPUT, OPTIONS)).toEqual({ ok: false, reason });
      expect(ledger.settlements).toEqual([]);
    }
    expect(network.calls).toHaveLength(0);
  });

  it("calls no model when the budget can not be checked, and frees its place", async () => {
    const network = fakeFetch(() => anthropicReply("x", { input_tokens: 1, output_tokens: 1 }));
    const warn = vi.fn();
    const reserve = vi
      .fn<AiBudget["reserve"]>()
      .mockRejectedValueOnce(new Error("connection terminated"))
      .mockResolvedValue({ ok: true, reservationId: "res-2" });
    const provider = createAiProvider({
      enabledProviders: ["bedrock"],
      budget: { reserve, settle: async () => undefined },
      fetch: network.fetch,
      awsCredentials: CREDENTIALS,
      log: { warn },
      maxConcurrentCalls: 1,
      callWaitMs: 10,
    });

    expect(await provider.run("inbox_draft", INPUT, OPTIONS)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: { name: "Error" } }),
      "AI budget check failed",
    );
    expect(network.calls).toHaveLength(0);
    // The only place under the provider-call limit is free again.
    expect(await provider.run("inbox_draft", INPUT, OPTIONS)).toMatchObject({ ok: true });
  });

  it("keeps the full reservation only when a request may have been billed", async () => {
    const failing = async (
      fetch: typeof globalThis.fetch,
      options = OPTIONS,
      credentials = CREDENTIALS,
    ) => {
      const ledger = fakeBudget();
      const provider = createAiProvider({
        enabledProviders: ["bedrock"],
        budget: ledger.budget,
        fetch,
        awsCredentials: credentials,
      });
      expect(await provider.run("inbox_translate", INPUT, options)).toEqual({
        ok: false,
        reason: "failed",
      });
      return {
        settled: ledger.settlements[0]![1],
        reserved: ledger.reservations[0]!.reservedMicroUsd,
      };
    };
    const unused = fakeFetch(() => anthropicReply("x", { input_tokens: 1, output_tokens: 1 }));

    // No AWS credentials: nothing was sent.
    const noCredentials = await failing(unused.fetch, OPTIONS, async () => {
      throw new Error("Could not load credentials from any providers");
    });
    expect(noCredentials.settled).toEqual({ status: "failed", costMicroUsd: 0 });

    // The person gave up before the call started: nothing was sent.
    const gaveUp = await failing(unused.fetch, { ...OPTIONS, abortSignal: AbortSignal.abort() });
    expect(gaveUp.settled).toEqual({ status: "failed", costMicroUsd: 0 });
    expect(unused.calls).toHaveLength(0);

    // The connection broke after sending, then the retry was throttled: the first may be billed.
    let attempt = 0;
    const broken = fakeFetch(() => {
      attempt += 1;
      if (attempt === 1)
        throw new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
      return new Response(JSON.stringify({ message: "Too many requests" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after-ms": "1" },
      });
    });
    const brokeAfterSending = await failing(broken.fetch);
    expect(brokeAfterSending.settled).toEqual({
      status: "failed",
      costMicroUsd: brokeAfterSending.reserved,
    });
  });

  it("still returns a paid answer whose usage could not be recorded", async () => {
    const network = fakeFetch(() => anthropicReply("Hello", { input_tokens: 1, output_tokens: 1 }));
    const warn = vi.fn();
    const budget: AiBudget = {
      reserve: async () => ({ ok: true, reservationId: "res-9" }),
      settle: async () => {
        throw new Error("connection terminated");
      },
    };
    const provider = createAiProvider({
      enabledProviders: ["bedrock"],
      budget,
      fetch: network.fetch,
      awsCredentials: CREDENTIALS,
      log: { warn },
    });

    expect(await provider.run("inbox_translate", INPUT, OPTIONS)).toMatchObject({
      ok: true,
      text: "Hello",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "res-9" }),
      "AI usage could not be recorded",
    );
  });

  it("runs at most the provider-call limit at once, across all accounts", async () => {
    let answer: (response: Response) => void = () => undefined;
    const network = fakeFetch(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const ledger = fakeBudget();
    const provider = createAiProvider({
      enabledProviders: ["bedrock"],
      budget: ledger.budget,
      fetch: network.fetch,
      awsCredentials: CREDENTIALS,
      maxConcurrentCalls: 1,
      callWaitMs: 10,
    });
    const otherAccount: AiRunOptions = {
      context: { ...OPTIONS.context, organizationId: "00000000-0000-4000-8000-000000000009" },
    };

    const first = provider.run("inbox_translate", INPUT, OPTIONS);
    await vi.waitFor(() => expect(network.calls).toHaveLength(1));
    expect(await provider.run("inbox_translate", INPUT, otherAccount)).toEqual({
      ok: false,
      reason: "busy",
    });
    expect(ledger.reservations).toHaveLength(1);

    answer(anthropicReply("Hello", { input_tokens: 1, output_tokens: 1 }));
    expect(await first).toMatchObject({ ok: true });
    const third = provider.run("inbox_translate", INPUT, otherAccount);
    await vi.waitFor(() => expect(network.calls).toHaveLength(2));
    answer(anthropicReply("Hello", { input_tokens: 1, output_tokens: 1 }));
    expect(await third).toMatchObject({ ok: true });
  });

  it("calls no model while no provider is switched on", async () => {
    const network = fakeFetch(() => anthropicReply("x", { input_tokens: 1, output_tokens: 1 }));
    const provider = createAiProvider({
      enabledProviders: [],
      budget: fakeBudget().budget,
      fetch: network.fetch,
      awsCredentials: CREDENTIALS,
    });

    expect(await provider.run("inbox_draft", INPUT, OPTIONS)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(network.calls).toHaveLength(0);
  });

  it("falls back to the next route whose provider is on", async () => {
    const network = fakeFetch(() => anthropicReply("ok", { input_tokens: 10, output_tokens: 2 }));
    const offProvider = { provider: "other", region: "eu", model: "m" } as unknown as ModelRoute;
    const provider = createAiProvider({
      enabledProviders: ["bedrock"],
      budget: fakeBudget().budget,
      fetch: network.fetch,
      awsCredentials: CREDENTIALS,
      tasks: {
        ...TASK_SETTINGS,
        inbox_draft: { ...TASK_SETTINGS.inbox_draft, routes: [offProvider, HAIKU] },
      },
    });

    const result = await provider.run("inbox_draft", INPUT, OPTIONS);

    expect(result).toMatchObject({ ok: true, route: HAIKU });
    expect(network.calls[0]!.url).toContain("/model/eu.anthropic.claude-haiku-5-5/");
  });

  it("sends customer data only to routes cleared for it", async () => {
    const network = fakeFetch(() => anthropicReply("x", { input_tokens: 1, output_tokens: 1 }));
    const warn = vi.fn();
    const provider = createAiProvider({
      enabledProviders: ["bedrock"],
      budget: fakeBudget().budget,
      fetch: network.fetch,
      awsCredentials: CREDENTIALS,
      log: { warn },
    });
    const global: ModelRoute = {
      provider: "bedrock",
      region: "eu-west-1",
      model: "global.anthropic.claude-sonnet-5-5",
    };

    expect(await provider.run("inbox_draft", INPUT, { ...OPTIONS, route: global })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ route: "bedrock:eu-west-1:global.anthropic.claude-sonnet-5-5" }),
      "AI route is not cleared for customer data",
    );
    // Made-up test data may use it, but an unpriced route still can not be budgeted.
    expect(
      await provider.run("inbox_draft", INPUT, { ...OPTIONS, data: "synthetic", route: global }),
    ).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(warn).toHaveBeenLastCalledWith(expect.any(Object), "AI route has no price");
    expect(network.calls).toHaveLength(0);
  });

  it("reports a refused call as failed and logs no prompt text", async () => {
    const network = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ message: `Malformed input: ${INPUT.messages[0]!.content}` }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const warn = vi.fn();
    const ledger = fakeBudget();
    const provider = createAiProvider({
      enabledProviders: ["bedrock"],
      budget: ledger.budget,
      fetch: network.fetch,
      awsCredentials: CREDENTIALS,
      log: { warn },
    });

    expect(await provider.run("inbox_translate", INPUT, OPTIONS)).toEqual({
      ok: false,
      reason: "failed",
    });
    // The provider turned the request down: nothing billed, the reservation is released.
    expect(ledger.settlements).toEqual([["res-1", { status: "failed", costMicroUsd: 0 }]]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "inbox_translate",
        requestId: "req-1",
        error: expect.objectContaining({ statusCode: 400 }),
      }),
      "AI provider call failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Guten Morgen");
  });

  it("never passes a refused, cut-off or empty answer as usable, but still reports what it cost", async () => {
    const usage = { input_tokens: 100, output_tokens: 4_096 };
    const replies = [
      anthropicReply("", { input_tokens: 100, output_tokens: 20 }, "refusal"),
      anthropicReply("Good mor", usage, "max_tokens"),
      anthropicReply("   ", { input_tokens: 100, output_tokens: 1 }),
    ];
    const network = fakeFetch(() => replies.shift()!);
    const ledger = fakeBudget();
    const provider = createAiProvider({
      enabledProviders: ["bedrock"],
      budget: ledger.budget,
      fetch: network.fetch,
      awsCredentials: CREDENTIALS,
    });

    expect(await provider.run("inbox_translate", INPUT, OPTIONS)).toMatchObject({
      ok: false,
      reason: "refused",
      usage: { inputTokens: 100, outputTokens: 20 },
      costMicroUsd: 22, // 100 x 110 + 20 x 550 nano-dollars
    });
    expect(await provider.run("inbox_translate", INPUT, OPTIONS)).toMatchObject({
      ok: false,
      reason: "truncated",
      costMicroUsd: 2_264, // 100 x 110 + 4,096 x 550 nano-dollars, rounded up
    });
    expect(await provider.run("inbox_translate", INPUT, OPTIONS)).toEqual({
      ok: false,
      reason: "failed",
    });
    // All three were answered and billed.
    expect(ledger.settlements.map(([, settlement]) => settlement.costMicroUsd)).toEqual([
      22, 2_264, 12,
    ]);
    expect(ledger.settlements.every(([, settlement]) => settlement.status === "completed")).toBe(
      true,
    );
  });

  it("logs the provider's status when it keeps throttling", async () => {
    const network = fakeFetch(
      () =>
        new Response(JSON.stringify({ message: "Too many requests" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after-ms": "1" },
        }),
    );
    const warn = vi.fn();
    const ledger = fakeBudget();
    const provider = createAiProvider({
      enabledProviders: ["bedrock"],
      budget: ledger.budget,
      fetch: network.fetch,
      awsCredentials: CREDENTIALS,
      log: { warn },
    });

    expect(await provider.run("inbox_translate", INPUT, OPTIONS)).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(network.calls).toHaveLength(2);
    // Bedrock turned both attempts down, so nothing was billed.
    expect(ledger.settlements).toEqual([["res-1", { status: "failed", costMicroUsd: 0 }]]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: { name: "AI_RetryError", statusCode: 429 } }),
      "AI provider call failed",
    );
  });

  it("keeps prompts and answers out of telemetry", async () => {
    const events: string[] = [];
    const capture = (event: unknown) => {
      events.push(JSON.stringify(event));
    };
    registerTelemetry({
      onStart: capture,
      onStepStart: capture,
      onLanguageModelCallStart: capture,
      onLanguageModelCallEnd: capture,
      onStepEnd: capture,
      onStepFinish: capture,
      onStepError: capture,
    });
    const network = fakeFetch(() =>
      anthropicReply("Good morning, is the room free?", { input_tokens: 10, output_tokens: 5 }),
    );
    const provider = createAiProvider({
      enabledProviders: ["bedrock"],
      budget: fakeBudget().budget,
      fetch: network.fetch,
      awsCredentials: CREDENTIALS,
    });

    expect(await provider.run("inbox_translate", INPUT, OPTIONS)).toMatchObject({ ok: true });

    expect(events.length).toBeGreaterThan(0);
    const recorded = events.join("\n");
    expect(recorded).not.toContain("Guten Morgen");
    expect(recorded).not.toContain("Translate the guest message");
    expect(recorded).not.toContain("is the room free");
  });

  it("gives up after the timeout and keeps the full reservation, since the call may have run", async () => {
    const ledger = fakeBudget();
    const slowFetch = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof globalThis.fetch;
    const provider = createAiProvider({
      enabledProviders: ["bedrock"],
      budget: ledger.budget,
      fetch: slowFetch,
      awsCredentials: CREDENTIALS,
      timeoutMs: 20,
    });

    expect(await provider.run("inbox_summarise", INPUT, OPTIONS)).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(ledger.reservations[0]!.holdMs).toBe(15_020);
    expect(ledger.settlements).toEqual([
      ["res-1", { status: "failed", costMicroUsd: ledger.reservations[0]!.reservedMicroUsd }],
    ]);
  });
});

describe("costMicroUsd", () => {
  it("bills a long Haiku prompt at the long-context rates", () => {
    const usage = {
      inputTokens: 100_001,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
    };
    // 100,001 x 550 + 1,000 x 2,750 nano-dollars, rounded up to whole micro-dollars
    expect(costMicroUsd(HAIKU, usage)).toBe(57_751);
    expect(costMicroUsd(HAIKU, { ...usage, inputTokens: 100_000 })).toBe(11_550);
  });

  it("prices the most a call can cost, at long-context rates when the prompt could reach them", () => {
    // 100,000 x 220 + 4,096 x 550 nano-dollars
    expect(maxCostMicroUsd(HAIKU, 100_000, 4_096)).toBe(24_253);
    // 100,001 x 1,100 + 4,096 x 2,750 nano-dollars
    expect(maxCostMicroUsd(HAIKU, 100_001, 4_096)).toBe(121_266);
  });

  it("has no price for routes outside the table", () => {
    const route: ModelRoute = {
      provider: "bedrock",
      region: "us-east-1",
      model: "us.anthropic.claude-haiku-5-5",
    };
    expect(
      costMicroUsd(route, {
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      }),
    ).toBeNull();
  });
});

describe("enabledAiProvidersFromEnv", () => {
  it("is off unless named and rejects unknown providers", () => {
    expect(enabledAiProvidersFromEnv({})).toEqual([]);
    expect(enabledAiProvidersFromEnv({ AI_PROVIDERS_ENABLED: " bedrock " })).toEqual(["bedrock"]);
    expect(() => enabledAiProvidersFromEnv({ AI_PROVIDERS_ENABLED: "bedrock,openai" })).toThrow(
      "AI_PROVIDERS_ENABLED names an unknown AI provider: openai",
    );
  });
});
