import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createHotelSetupOrdinaryLoginFixture,
  type HotelSetupOrdinaryLoginFixture,
} from "../../hotelSetupOrdinaryLogin.fixture.js";
import { createAiProvider } from "../provider/aiProvider.js";
import { bedrockStream, claudeReply } from "../provider/bedrockStream.fixtures.js";
import { runAssistantTurn, type AssistantEvent, type AssistantTool } from "./assistantTurn.js";
import {
  ChatHistoryError,
  type ChatMessage,
  type ConversationOwner,
  type ConversationStore,
  createPgConversationStore,
  purgeExpiredConversations,
} from "./conversationStore.js";
import { requestContract } from "./requestContract.js";

/**
 * VAY-2518: the in-app assistant's chat history on real PostgreSQL, written by the ordinary API
 * login as in production.
 */
const url = process.env["TEST_DATABASE_URL"];
const SONNET = {
  provider: "bedrock",
  region: "eu-west-1",
  model: "eu.anthropic.claude-sonnet-5-5",
} as const;
const CONTRACT = requestContract({
  route: SONNET,
  systemPrompt: "You are vayada's assistant.",
  tools: [
    { name: "rooms_list", description: "Lists rooms", inputSchema: {}, outputSchema: {} },
    { name: "calendar_days", description: "Reads days", inputSchema: {}, outputSchema: {} },
  ],
});
// What the next deploy sends: another prompt and no tools.
const NEW_CONTRACT = requestContract({
  route: SONNET,
  systemPrompt: "You are vayada's assistant. Be brief.",
  tools: [],
});

const question = (text: string): ChatMessage => ({ role: "user", content: text });
const toolCall = (toolCallId: string, input: unknown = { propertyId: "p1" }) => ({
  type: "tool-call",
  toolCallId,
  toolName: "rooms_list",
  input,
});
const askTools = (...ids: string[]): ChatMessage => ({
  role: "assistant",
  content: ids.map((id) => toolCall(id)),
});
const results = (...ids: string[]): ChatMessage => ({
  role: "tool",
  content: ids.map((toolCallId) => ({
    type: "tool-result",
    toolCallId,
    toolName: "rooms_list",
    output: { type: "json", value: { rooms: [{ name: "Deluxe", id: toolCallId }] } },
  })),
});
const answer = (text: string): ChatMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

describe.skipIf(!url)("assistant conversation store on PostgreSQL (VAY-2518)", () => {
  let admin: pg.Client;
  let fixture: HotelSetupOrdinaryLoginFixture;
  let pool: pg.Pool;
  let store: ConversationStore;
  const org = randomUUID();
  const otherOrg = randomUUID();
  const user = randomUUID();
  const otherUser = randomUUID();
  const property = randomUUID();
  const otherProperty = randomUUID();
  const owner: ConversationOwner = {
    organizationId: org,
    propertyId: property,
    userId: user,
    app: "pms",
  };

  async function start(text: string, conversationId?: string, who = owner) {
    const started = await store.startTurn({
      owner: who,
      contract: CONTRACT,
      message: question(text),
      ...(conversationId ? { conversationId } : {}),
    });
    if (started.status !== "started") throw new Error(`turn not started: ${started.status}`);
    return started;
  }
  const read = (conversationId: string, contract = CONTRACT, who = owner) =>
    store.read(who, conversationId, contract.sha256);
  const staleHeartbeat = (turnId: string) =>
    admin.query(
      `UPDATE platform.ai_conversation_turns SET heartbeat_at = now() - interval '2 minutes'
        WHERE id = $1::uuid`,
      [turnId],
    );

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    for (const id of [org, otherOrg])
      await admin.query(
        `INSERT INTO identity.organizations (id, kind, name, slug, workos_org_id)
         VALUES ($1::uuid, 'hotel_group', 'VAY-2518 hotel', $1::text, 'wk-org-' || $1::text)`,
        [id],
      );
    for (const id of [user, otherUser])
      await admin.query(
        "INSERT INTO identity.users (id, email, name, status) VALUES ($1::uuid, $2, 'VAY-2518', 'active')",
        [id, `vay2518-${id}@example.test`],
      );
    for (const id of [property, otherProperty])
      await admin.query(
        "INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1::uuid, $2, 'Hotel Alpenrose')",
        [id, `vay-2518-${id}`],
      );
    fixture = await createHotelSetupOrdinaryLoginFixture(admin, url!);
    pool = new pg.Pool({ connectionString: fixture.connectionString, max: 4 });
    store = createPgConversationStore({ pool });
  });

  afterAll(async () => {
    await pool?.end();
    await fixture?.drop();
    if (admin) {
      await admin.query(
        "DELETE FROM platform.ai_conversations WHERE organization_id = ANY($1::uuid[])",
        [[org, otherOrg]],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
        [property, otherProperty],
      ]);
      await admin.query("DELETE FROM identity.users WHERE id = ANY($1::uuid[])", [
        [user, otherUser],
      ]);
      await admin.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
        [org, otherOrg],
      ]);
      await admin.end();
    }
  });

  it("keeps every message exactly as handed over and replays the whole history in order", async () => {
    const first = await start("Which rooms do we have?");
    expect(first.messages).toEqual([question("Which rooms do we have?")]);

    // jsonb would store this input as {to, from, propertyId}, and the replayed request would
    // differ from the cached one. Also a signed reasoning part, kept as it is.
    const step: ChatMessage = {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Look up the rooms.",
          providerOptions: { bedrock: { signature: "c2lnbmVk", redactedData: "" } },
        },
        toolCall("toolu_a1", { propertyId: property, from: "2026-12-01", to: "2026-12-02" }),
      ],
    };
    expect(await store.append(first.turnId, [step, results("toolu_a1")])).toEqual({
      status: "appended",
    });
    expect(await store.append(first.turnId, [answer("You have one room: Deluxe.")])).toEqual({
      status: "appended",
    });
    expect(await store.endTurn(first.turnId, { status: "done" })).toBe(true);

    const second = await start("And on 6 March?", first.conversationId);
    const sent = [
      question("Which rooms do we have?"),
      step,
      results("toolu_a1"),
      answer("You have one room: Deluxe."),
      question("And on 6 March?"),
    ];
    expect(second.messages.map((message) => JSON.stringify(message))).toEqual(
      sent.map((message) => JSON.stringify(message)),
    );
    expect(JSON.stringify(second.messages[1])).toContain(
      `"input":{"propertyId":"${property}","from":"2026-12-01","to":"2026-12-02"}`,
    );

    const view = await read(first.conversationId);
    expect(view).toMatchObject({ id: first.conversationId, readOnlyReason: null });
    expect(view!.turns.map((turn) => [turn.seq, turn.status])).toEqual([
      [1, "done"],
      [2, "running"],
    ]);
    expect(view!.messages.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(view!.messages[1]!.turnId).toBe(first.turnId);
    expect(await store.endTurn(second.turnId, { status: "done" })).toBe(true);
  });

  it("gives every tool call exactly one result, right after it, and refuses a batch whole", async () => {
    const { turnId, conversationId } = await start("Check two rooms");
    await store.append(turnId, [askTools("toolu_b1", "toolu_b2")]);

    const refused = async (messages: ChatMessage[], error: string) => {
      await expect(store.append(turnId, messages)).rejects.toThrow(ChatHistoryError);
      await expect(store.append(turnId, messages)).rejects.toThrow(error);
    };
    await refused([results("toolu_zz")], "answers no open tool call");
    await refused([answer("Done.")], "no results yet");
    // The first message of a refused batch is not kept either.
    await refused([results("toolu_b1"), results("toolu_b1")], "answers no open tool call");
    // A loop that says it is done while calls wait for results has a bug.
    await expect(store.endTurn(turnId, { status: "done" })).rejects.toThrow("can't be done");
    await store.append(turnId, [results("toolu_b1", "toolu_b2")]);
    await refused([results("toolu_b2")], "answers no open tool call");
    await refused([askTools("toolu_b1")], "already made");

    const view = await read(conversationId);
    expect(view!.messages.map((row) => row.message.role)).toEqual(["user", "assistant", "tool"]);
    await store.endTurn(turnId, { status: "done" });
  });

  it("shows a conversation only to its own user, for its own property, account and app", async () => {
    const { conversationId, turnId } = await start("Only mine");
    await store.endTurn(turnId, { status: "done" });
    for (const stranger of [
      { ...owner, userId: otherUser },
      { ...owner, propertyId: otherProperty },
      { ...owner, organizationId: otherOrg },
      { ...owner, app: "booking_admin" as const },
    ]) {
      expect(await read(conversationId, CONTRACT, stranger)).toBeUndefined();
      expect(
        await store.startTurn({
          owner: stranger,
          conversationId,
          contract: CONTRACT,
          message: question("Let me in"),
        }),
      ).toEqual({ status: "not_found" });
      expect(await store.list(stranger, CONTRACT.sha256, { limit: 100 })).toEqual([]);
      expect(await store.exists(stranger, conversationId)).toBe(false);
    }
    expect(await store.exists(owner, conversationId)).toBe(true);
    expect(await read("not-a-uuid")).toBeUndefined();
    expect(await store.exists(owner, "not-a-uuid")).toBe(false);
    expect(await store.exists(owner, randomUUID())).toBe(false);
  });

  it("runs one turn per conversation at a time: a second tab or a double click is busy", async () => {
    const { conversationId, turnId } = await start("First");
    const again = () =>
      store.startTurn({ owner, conversationId, contract: CONTRACT, message: question("Again") });
    expect(await Promise.all([again(), again()])).toEqual([{ status: "busy" }, { status: "busy" }]);
    await store.endTurn(turnId, { status: "done" });
    const next = await Promise.all([again(), again()]);
    expect(next.map((result) => result.status).sort()).toEqual(["busy", "started"]);
    const started = next.find((result) => result.status === "started");
    if (started?.status === "started") await store.endTurn(started.turnId, { status: "done" });
  });

  it("closes a turn cut off by a deploy as interrupted, saying what ran and what did not", async () => {
    const { conversationId, turnId } = await start("Close Deluxe and tell me the rooms");
    await store.append(turnId, [askTools("toolu_c1", "toolu_c2")]);
    await store.append(turnId, [results("toolu_c1")]);
    expect(await store.heartbeat(turnId)).toBe(true);

    // Still beating: the turn runs on, and a new question is busy.
    expect((await read(conversationId))!.turns).toMatchObject([{ status: "running" }]);
    expect(
      await store.startTurn({ owner, conversationId, contract: CONTRACT, message: question("?") }),
    ).toEqual({ status: "busy" });

    // The deploy stopped the task: no beat for two minutes.
    await staleHeartbeat(turnId);
    const view = await read(conversationId);
    expect(view!.turns).toMatchObject([
      { status: "interrupted", endReason: "no_heartbeat", endedAt: expect.any(String) },
    ]);
    expect(view!.messages.map((row) => row.message)).toEqual([
      question("Close Deluxe and tell me the rooms"),
      askTools("toolu_c1", "toolu_c2"),
      results("toolu_c1"),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_c2",
            toolName: "rooms_list",
            output: {
              type: "error-json",
              value: {
                error: "interrupted",
                detail:
                  "The answer was cut off before this step's result was recorded. It may or " +
                  "may not have run: check before doing it again.",
              },
            },
          },
        ],
      },
    ]);

    // The old task, if it is still alive somewhere, may not add to the closed turn.
    expect(await store.append(turnId, [results("toolu_c2")])).toEqual({ status: "turn_ended" });
    expect(await store.heartbeat(turnId)).toBe(false);
    expect(await store.endTurn(turnId, { status: "done" })).toBe(false);

    // The conversation goes on with a valid history.
    const next = await start("Try again", conversationId);
    expect(next.messages).toHaveLength(5);
    await store.endTurn(next.turnId, { status: "done" });
  });

  it("closes a stale turn when the next question arrives, before starting a new one", async () => {
    const { conversationId, turnId } = await start("Will be cut off");
    await store.append(turnId, [askTools("toolu_d1")]);
    await staleHeartbeat(turnId);
    const next = await start("Hello again", conversationId);
    expect(next.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    await store.endTurn(next.turnId, { status: "done" });
  });

  it("answers a turn's open tool calls with not_run when it stops at a limit", async () => {
    const { conversationId, turnId } = await start("Loop forever");
    await store.append(turnId, [askTools("toolu_e1")]);
    expect(await store.endTurn(turnId, { status: "stopped", reason: "step_limit" })).toBe(true);
    const view = await read(conversationId);
    expect(view!.turns[0]).toMatchObject({ status: "stopped", endReason: "step_limit" });
    expect(view!.messages.at(-1)!.message).toMatchObject({
      role: "tool",
      content: [
        { toolCallId: "toolu_e1", output: { value: { error: "not_run", reason: "step_limit" } } },
      ],
    });
    await expect(
      store.endTurn(turnId, { status: "stopped", reason: "Step Limit" }),
    ).rejects.toThrow("snake_case");
  });

  it("can't be continued on another request contract, but stays open for its own", async () => {
    const { conversationId, turnId } = await start("Before the deploy");
    const ask = (contract: typeof CONTRACT) =>
      store.startTurn({ owner, conversationId, contract, message: question("After the deploy") });
    // Even while its turn runs: the contract is checked first.
    expect(await ask(NEW_CONTRACT)).toEqual({ status: "read_only", reason: "contract_changed" });
    await store.endTurn(turnId, { status: "done" });
    expect(await ask(NEW_CONTRACT)).toEqual({ status: "read_only", reason: "contract_changed" });
    expect((await read(conversationId, NEW_CONTRACT))!.readOnlyReason).toBe("contract_changed");
    expect(
      (await store.list(owner, NEW_CONTRACT.sha256, { limit: 100 })).find(
        (chat) => chat.id === conversationId,
      )?.readOnlyReason,
    ).toBe("contract_changed");

    // During a rolling deploy an API task on the chat's own version still answers it.
    expect((await read(conversationId))!.readOnlyReason).toBeNull();
    const continued = await ask(CONTRACT);
    expect(continued.status).toBe("started");
    if (continued.status === "started") await store.endTurn(continued.turnId, { status: "done" });
  });

  it("is read-only for good after 100 turns or about 150K tokens of history", async () => {
    const long = await start("Turn 1");
    await store.endTurn(long.turnId, { status: "done" });
    await admin.query(
      `INSERT INTO platform.ai_conversation_turns (conversation_id, seq, status, ended_at)
       SELECT $1::uuid, turn, 'done', now() FROM generate_series(2, 100) turn`,
      [long.conversationId],
    );
    const continueLong = () =>
      store.startTurn({
        owner,
        conversationId: long.conversationId,
        contract: CONTRACT,
        message: question("Turn 101"),
      });
    expect(await continueLong()).toEqual({ status: "read_only", reason: "too_long" });
    expect((await read(long.conversationId))!.readOnlyReason).toBe("too_long");
    // Read-only, but still there: an answer to it still belongs to a chat the person can open.
    expect(await store.exists(owner, long.conversationId)).toBe(true);

    const big = await start("Read me everything");
    for (let n = 0; n < 3; n += 1)
      await store.append(big.turnId, [answer(`${n} `.padEnd(210_000, "x"))]);
    await store.endTurn(big.turnId, { status: "done" });
    expect(
      await store.startTurn({
        owner,
        conversationId: big.conversationId,
        contract: CONTRACT,
        message: question("And more"),
      }),
    ).toEqual({ status: "read_only", reason: "too_long" });
  });

  it("never changes a stored message, even for the API login", async () => {
    const { conversationId, turnId } = await start("Immutable");
    await store.endTurn(turnId, { status: "done" });
    await expect(
      pool.query(
        `UPDATE platform.ai_conversation_messages SET message = '{"role":"user","content":"edited"}'
          WHERE conversation_id = $1::uuid`,
        [conversationId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("lists the user's chats for the property and app, newest first, page by page", async () => {
    const listOwner: ConversationOwner = {
      ...owner,
      propertyId: otherProperty,
      app: "booking_admin",
    };
    const ids: string[] = [];
    for (const text of ["  Older   question\nwith lines ", "Newer question"]) {
      const started = await store.startTurn({
        owner: listOwner,
        contract: CONTRACT,
        message: { role: "user", content: [{ type: "text", text }] },
      });
      if (started.status !== "started") throw new Error(started.status);
      await store.endTurn(started.turnId, { status: "done" });
      ids.push(started.conversationId);
    }
    const all = await store.list(listOwner, CONTRACT.sha256, { limit: 10 });
    expect(all.map((chat) => [chat.id, chat.preview, chat.readOnlyReason])).toEqual([
      [ids[1], "Newer question", null],
      [ids[0], "Older question with lines", null],
    ]);
    // One microsecond apart, in the same millisecond: a cursor cut to milliseconds (a JS Date)
    // would skip the older chat.
    await admin.query(
      `UPDATE platform.ai_conversations
          SET last_activity_at = CASE id WHEN $1::uuid THEN timestamptz '2026-11-23 10:00:00.000201+00'
                                         ELSE timestamptz '2026-11-23 10:00:00.000200+00' END
        WHERE id IN ($1::uuid, $2::uuid)`,
      [ids[1], ids[0]],
    );
    const first = await store.list(listOwner, CONTRACT.sha256, { limit: 1 });
    expect(first.map((chat) => chat.id)).toEqual([ids[1]]);
    const rest = await store.list(listOwner, CONTRACT.sha256, {
      limit: 1,
      before: { lastActivityAt: first[0]!.lastActivityAt, id: first[0]!.id },
    });
    expect(rest.map((chat) => chat.id)).toEqual([ids[0]]);
    await expect(
      store.list(listOwner, CONTRACT.sha256, {
        limit: 1,
        before: { lastActivityAt: first[0]!.lastActivityAt, id: "x" },
      }),
    ).rejects.toThrow("cursor");
  });

  it("runs a whole turn on the real provider: what the SDK returned is stored and sent back unchanged", async () => {
    const replies = [
      claudeReply(
        [
          { type: "thinking", thinking: "Look up the rooms.", signature: "sig-pg-1" },
          { type: "text", text: "Let me check." },
          {
            type: "tool_use",
            id: "toolu_pg1",
            name: "rooms_list",
            input: { propertyId: property },
          },
        ],
        { input_tokens: 500, output_tokens: 40 },
      ),
      claudeReply([{ type: "text", text: "You have one room: Deluxe." }], {
        input_tokens: 40,
        cache_read_input_tokens: 520,
        output_tokens: 12,
      }),
    ];
    const sent: { messages: { role: string; content: Record<string, unknown>[] }[] }[] = [];
    const provider = createAiProvider({
      enabledProviders: ["bedrock"],
      budget: {
        reserve: async () => ({ ok: true, reservationId: "res-pg" }),
        settle: async () => undefined,
      },
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)) as (typeof sent)[number]);
        return bedrockStream(replies.shift()!);
      }) as typeof globalThis.fetch,
      awsCredentials: async () => ({ accessKeyId: "AKIAFAKEFAKEFAKEFAKE", secretAccessKey: "x" }),
    });
    const tool: AssistantTool = {
      definition: {
        name: "rooms_list",
        description: "Lists the property's rooms.",
        inputSchema: { type: "object", properties: { propertyId: { type: "string" } } },
        outputSchema: { type: "object" },
      },
      run: async () => ({ ok: true, data: { rooms: [{ name: "Deluxe" }] } }),
    };
    const instructions = "You are vayada's assistant for hotel staff.";
    const events: AssistantEvent[] = [];
    const end = await runAssistantTurn({
      store,
      provider,
      owner,
      question: "Which rooms do we have?",
      instructions,
      tools: [tool],
      requestId: "req-pg",
      emit: (event) => events.push(event),
    });
    expect(end).toEqual({ type: "end", status: "done", reason: null });
    const started = events.find((event) => event.type === "turn");
    if (started?.type !== "turn") throw new Error("no turn");

    const contract = requestContract({
      route: SONNET,
      systemPrompt: instructions,
      tools: [tool.definition],
    });
    const view = await read(started.conversationId, contract);
    expect(view!.readOnlyReason).toBeNull();
    expect(view!.turns).toMatchObject([{ status: "done" }]);
    expect(view!.messages.map((row) => row.message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(JSON.stringify(view!.messages[1]!.message)).toContain("sig-pg-1");
    // The second request carried the stored thinking and tool call exactly as Claude sent them.
    const assistant = sent[1]!.messages.find((message) => message.role === "assistant")!;
    expect(assistant.content[0]).toMatchObject({ type: "thinking", signature: "sig-pg-1" });
    expect(assistant.content.at(-1)).toMatchObject({
      type: "tool_use",
      id: "toolu_pg1",
      input: { propertyId: property },
    });
  });

  it("deletes a conversation with its turns and messages 30 days after its last activity", async () => {
    const old = await start("31 days ago");
    await store.append(old.turnId, [answer("Hello")]);
    await store.endTurn(old.turnId, { status: "done" });
    const recent = await start("29 days ago");
    await store.endTurn(recent.turnId, { status: "done" });
    await admin.query(
      `UPDATE platform.ai_conversations
          SET last_activity_at = now() - CASE id WHEN $1::uuid THEN interval '31 days'
                                                 ELSE interval '29 days' END
        WHERE id IN ($1::uuid, $2::uuid)`,
      [old.conversationId, recent.conversationId],
    );

    // A far-future clock in the app must not purge early: the database clock caps it.
    expect(
      await purgeExpiredConversations(pool, new Date("2099-01-01T00:00:00Z"), 1_000),
    ).toBeGreaterThanOrEqual(1);
    expect(await read(old.conversationId)).toBeUndefined();
    expect(await read(recent.conversationId)).toBeDefined();
    expect(await store.exists(owner, old.conversationId)).toBe(false);
    expect(await store.exists(owner, recent.conversationId)).toBe(true);
    const left = await admin.query<{ turns: number; messages: number }>(
      `SELECT (SELECT count(*)::int FROM platform.ai_conversation_turns WHERE conversation_id = $1::uuid) AS turns,
              (SELECT count(*)::int FROM platform.ai_conversation_messages WHERE conversation_id = $1::uuid) AS messages`,
      [old.conversationId],
    );
    expect(left.rows[0]).toEqual({ turns: 0, messages: 0 });
  });
});
