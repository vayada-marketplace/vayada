// The record of every AI change on PostgreSQL (VAY-2524): one row per change, found again by a
// retried tool call, started by exactly one caller, taken over once when its lease runs out, and
// deleted with its retention.
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgAiActionLogRetentionStore } from "../actionLog/aiActivity.js";
import {
  AiOperationStoreError,
  canonicalJson,
  createPgAiOperationStore,
  MAX_ATTEMPTS,
  operationBusinessKey,
  PENDING_ANSWER_MS,
  RETRY_JOIN_MS,
  storedArguments,
  UNSCOPED_RETRY_JOIN_MS,
  type ProposedChange,
} from "./operationStore.js";

const URL_ = process.env["TEST_DATABASE_URL"];
const ORG = randomUUID();
const PROPERTY = randomUUID();
const USER = randomUUID();
const T0 = new Date("2026-12-01T09:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const A = { holder: "task-a", ms: 60_000 };
const B = { holder: "task-b", ms: 60_000 };

let seq = 0;
/** A change in a conversation of its own, so tests don't find each other's rows. */
function change(overrides: Partial<ProposedChange> = {}): ProposedChange {
  return {
    organizationId: ORG,
    propertyId: PROPERTY,
    userId: USER,
    surface: "in_app",
    conversationId: randomUUID(),
    requestScope: "turn-1",
    client: "vayada:pms",
    action: { name: "thread_mark_done", version: 1, group: "ask" },
    arguments: {
      propertyId: PROPERTY,
      threadId: randomUUID(),
      expectedThreadVersion: ++seq,
    },
    ...overrides,
  };
}

const step = (n: number, statusCode = 200) => ({
  step: n,
  requestId: randomUUID(),
  idempotencyKeySha256: "a".repeat(64),
  statusCode,
  at: T0.toISOString(),
});

describe("the business key (VAY-2524)", () => {
  it("is the same for the same change, whatever the key order, and differs otherwise", () => {
    const base = change();
    const reordered = {
      ...base,
      arguments: Object.fromEntries(Object.entries(base.arguments).reverse()),
    };
    expect(operationBusinessKey(reordered)).toBe(operationBusinessKey(base));
    // The request scope only decides whether an ended change joins: never part of the key.
    expect(operationBusinessKey({ ...base, requestScope: "turn-2" })).toBe(
      operationBusinessKey(base),
    );
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: null }] })).toBe('{"a":[{"c":null,"d":2}],"b":1}');
    for (const other of [
      { ...base, arguments: { ...base.arguments, expectedThreadVersion: 99 } },
      { ...base, conversationId: randomUUID() },
      { ...base, userId: randomUUID() },
      { ...base, action: { ...base.action, version: 2 } },
    ]) {
      expect(operationBusinessKey(other)).not.toBe(operationBusinessKey(base));
    }
  });

  it("hashes exactly the JSON it stores: dates as text, no undefined members", () => {
    const base = change();
    const day = (date: string) => ({
      ...base,
      arguments: { ...base.arguments, on: new Date(date) },
    });
    expect(operationBusinessKey(day("2026-12-10"))).not.toBe(
      operationBusinessKey(day("2026-12-11")),
    );
    expect(
      operationBusinessKey({ ...base, arguments: { ...base.arguments, reason: undefined } }),
    ).toBe(operationBusinessKey(base));
    expect(() =>
      operationBusinessKey({ ...base, arguments: { ...base.arguments, n: BigInt(1) } }),
    ).toThrow(AiOperationStoreError);
  });

  it("refuses arguments the database would refuse while quoting them", () => {
    for (const bad of [
      { note: "a\u0000b" },
      { note: "half \ud800 pair" },
      { note: "x".repeat(40_000) },
    ]) {
      expect(() => storedArguments({ propertyId: PROPERTY, ...bad })).toThrow(
        AiOperationStoreError,
      );
    }
  });
});

describe.skipIf(!URL_)("AI operations on PostgreSQL (VAY-2524)", () => {
  const admin = new pg.Client({ connectionString: URL_ });
  // The pool connects on first use: without a database the suite skips before that.
  const store = createPgAiOperationStore({
    connectionString: URL_ ?? "postgresql://integration-test-disabled",
    max: 6,
  });

  beforeAll(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(URL_!).pathname)) {
      throw new Error("Test database required");
    }
    await admin.connect();
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, $2, 'AI change tester', 'active')`,
      [USER, `${USER}@example.test`],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'AI changes', $2, 'active')`,
      [ORG, `ai-changes-${ORG}`],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, 'AI changes hotel')`,
      [PROPERTY, `ai-changes-${PROPERTY}`],
    );
  });

  afterAll(async () => {
    await store.end();
    await admin.query(`DELETE FROM platform.ai_operations WHERE organization_id = $1::uuid`, [ORG]);
    await admin.query(`DELETE FROM hotel_catalog.properties WHERE id = $1::uuid`, [PROPERTY]);
    await admin.query(`DELETE FROM identity.organizations WHERE id = $1::uuid`, [ORG]);
    await admin.query(`DELETE FROM identity.users WHERE id = $1::uuid`, [USER]);
    await admin.end();
  });

  /** Proposes, starts as A and finishes, for tests about ended changes. */
  async function ended(asked: ProposedChange, outcome: "done" | "failed", withStep = true) {
    const { operation } = await store.propose(asked, T0);
    const started = (await store.start(operation.id, A, at(1_000)))!.operation;
    if (withStep) await store.recordStep(operation.id, started.leaseOwner!, step(1));
    await store.finish(
      operation.id,
      started.leaseOwner!,
      outcome === "done"
        ? { status: "done", result: { ok: 1 } }
        : { status: "failed", errorCode: "x" },
      at(2_000),
    );
    return operation.id;
  }

  it("writes an Ask-first change as pending, waiting 15 minutes or its preview's expiry", async () => {
    const asked = change();
    const { operation, created } = await store.propose(asked, T0);
    expect(created).toBe(true);
    expect(operation).toMatchObject({
      status: "pending",
      group: "ask",
      action: "thread_mark_done",
      surface: "in_app",
      conversationId: asked.conversationId,
      connectionId: null,
      requestScope: "turn-1",
      businessKey: operationBusinessKey(asked),
      arguments: asked.arguments,
      expiresAt: at(PENDING_ANSWER_MS).toISOString(),
      previewSha256: null,
      attempts: 0,
      steps: [],
    });
    const preview = "b".repeat(64);
    expect(
      (await store.propose(change({ previewSha256: preview, expiresInMs: 600_000 }), T0)).operation,
    ).toMatchObject({ previewSha256: preview, expiresAt: at(600_000).toISOString() });
    await expect(store.propose(change({ expiresInMs: PENDING_ANSWER_MS + 1 }), T0)).rejects.toThrow(
      AiOperationStoreError,
    );
  });

  it("refuses arguments for another property", async () => {
    const asked = change();
    await expect(
      store.propose({ ...asked, arguments: { ...asked.arguments, propertyId: randomUUID() } }, T0),
    ).rejects.toThrow(/another property/);
  });

  it("gives a retry the same change; a pending change is joined from any turn", async () => {
    const asked = change();
    const first = await store.propose(asked, T0);
    const again = await store.propose(
      { ...asked, arguments: Object.fromEntries(Object.entries(asked.arguments).reverse()) },
      at(5_000),
    );
    expect(again).toEqual({ operation: first.operation, created: false });
    // A turn cut off by a deploy, asked again: still the one card, never a second.
    expect(await store.propose({ ...asked, requestScope: "turn-2" }, at(6_000))).toEqual({
      operation: first.operation,
      created: false,
    });
  });

  it("asks again when the card's preview changed", async () => {
    const asked = change({ previewSha256: "c".repeat(64) });
    const first = await store.propose(asked, T0);
    const second = await store.propose({ ...asked, previewSha256: "d".repeat(64) }, at(1_000));
    expect(second.created).toBe(true);
    expect(await store.find(first.operation.id)).toMatchObject({
      status: "closed",
      closeReason: "changed",
    });
  });

  it("writes one change for copies of a tool call sent at once", async () => {
    const asked = change();
    const results = await Promise.all(Array.from({ length: 5 }, () => store.propose(asked, T0)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.operation.id)).size).toBe(1);
  });

  it("joins a done change only while retries come, in its turn, so the same request runs again", async () => {
    const asked = change();
    const id = await ended(asked, "done"); // finished at 2 s
    expect(await store.propose(asked, at(2_000 + RETRY_JOIN_MS - 1))).toMatchObject({
      created: false,
      operation: { id, status: "done", result: { ok: 1 } },
    });
    // A new question in a new turn is a new request.
    expect((await store.propose({ ...asked, requestScope: "turn-2" }, at(3_000))).created).toBe(
      true,
    );
    const later = change();
    await ended(later, "done");
    expect((await store.propose(later, at(2_000 + RETRY_JOIN_MS + 1))).created).toBe(true);
  });

  it("counts the retry window from the answer, not from the question", async () => {
    // A Yes in the card's 14th minute, and the resumed turn retrying half a minute later.
    const asked = change();
    const { operation } = await store.propose(asked, T0);
    const token = (await store.start(operation.id, A, at(14 * 60_000)))!.operation.leaseOwner!;
    await store.finish(operation.id, token, { status: "done", result: { ok: 1 } }, at(14 * 60_000));
    expect(await store.propose(asked, at(14.5 * 60_000))).toMatchObject({
      created: false,
      operation: { id: operation.id, status: "done" },
    });
  });

  it("on MCP, joins only quick resends, and asks again once anything else happened", async () => {
    const connectionId = randomUUID();
    const mcp = (extra: Partial<ProposedChange> = {}) =>
      change({
        surface: "mcp",
        conversationId: undefined,
        connectionId,
        requestScope: undefined,
        ...extra,
      });
    const block = mcp();
    const id = await ended(block, "done");
    expect(await store.propose(block, at(2_000 + UNSCOPED_RETRY_JOIN_MS - 1))).toMatchObject({
      created: false,
      operation: { id },
    });
    // Block, release, block again: the release in between makes the second block a new request.
    await store.propose(mcp(), at(3_000));
    expect((await store.propose(block, at(4_000))).created).toBe(true);
    const late = mcp();
    await ended(late, "done");
    expect((await store.propose(late, at(2_000 + UNSCOPED_RETRY_JOIN_MS + 1))).created).toBe(true);
  });

  it("tells a retry about a No; asks again after an expiry or a change", async () => {
    const asked = change();
    const declined = await store.propose(asked, T0);
    await store.closePending(declined.operation.id, "declined", at(1_000));
    expect(await store.propose(asked, at(2_000))).toMatchObject({
      created: false,
      operation: { id: declined.operation.id, closeReason: "declined" },
    });

    const changed = change();
    const stale = await store.propose(changed, T0);
    await store.closePending(stale.operation.id, "changed", at(1_000));
    expect((await store.propose(changed, at(2_000))).created).toBe(true);

    const unanswered = change();
    const old = await store.propose(unanswered, T0);
    const next = await store.propose(unanswered, at(PENDING_ANSWER_MS));
    expect(next.created).toBe(true);
    // The old card was closed when the new one was written: it can never start any more.
    expect(await store.find(old.operation.id)).toMatchObject({
      status: "closed",
      closeReason: "expired",
    });
    expect(await store.start(old.operation.id, A, at(PENDING_ANSWER_MS - 1))).toMatchObject({
      won: false,
      operation: { status: "closed" },
    });
  });

  it("joins a failed change only if it sent a request", async () => {
    const sent = change();
    const id = await ended(sent, "failed", true);
    expect(await store.propose(sent, at(3_000))).toMatchObject({
      created: false,
      operation: { id },
    });
    const refused = change();
    await ended(refused, "failed", false);
    expect((await store.propose(refused, at(3_000))).created).toBe(true);
  });

  it("joins a running change however old, and never holds two live rows of one change", async () => {
    const asked = change();
    const { operation } = await store.propose(asked, T0);
    await store.start(operation.id, A, at(1_000));
    expect(await store.propose(asked, at(10 * RETRY_JOIN_MS))).toMatchObject({
      created: false,
      operation: { id: operation.id, status: "running" },
    });
    await expect(
      admin.query(
        `INSERT INTO platform.ai_operations
           (organization_id, property_id, user_id, surface, conversation_id, client, action,
            action_version, action_group, business_key, arguments, status, expires_at)
         VALUES ($1, $2, $3, 'in_app', $4, 'x', 'thread_mark_done', 1, 'ask', $5, '{}', 'pending',
                 now() + interval '1 minute')`,
        [ORG, PROPERTY, USER, asked.conversationId, operationBusinessKey(asked)],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("starts a change for exactly one caller: a double click or a second tab joins the run", async () => {
    const { operation } = await store.propose(change(), T0);
    const [first, second] = await Promise.all([
      store.start(operation.id, A, at(1_000)),
      store.start(operation.id, B, at(1_000)),
    ]);
    expect([first?.won, second?.won].filter(Boolean)).toHaveLength(1);
    const winner = first?.won ? first : second;
    const joiner = first?.won ? second : first;
    expect(winner?.operation).toMatchObject({
      status: "running",
      attempts: 1,
      startedAt: at(1_000).toISOString(),
      leaseExpiresAt: at(61_000).toISOString(),
    });
    expect(joiner).toMatchObject({
      won: false,
      // Only the winner holds the lease token.
      operation: { id: operation.id, status: "running", leaseOwner: null },
    });
    expect(winner?.operation.leaseOwner).toMatch(/^task-[ab]:[0-9a-f]{16}$/);
    expect((await store.find(operation.id))?.leaseOwner).toBeNull();
    expect(await store.start(randomUUID(), A, at(1_000))).toBeNull();
  });

  it("closes a change answered after its expiry as expired", async () => {
    const late = await store.propose(change(), T0);
    expect(await store.start(late.operation.id, A, at(PENDING_ANSWER_MS))).toMatchObject({
      won: false,
      operation: { status: "closed", closeReason: "expired" },
    });
    const lateNo = await store.propose(change(), T0);
    expect(
      await store.closePending(lateNo.operation.id, "declined", at(PENDING_ANSWER_MS)),
    ).toMatchObject({ status: "closed", closeReason: "expired" });
    expect(await store.closePending(lateNo.operation.id, "declined", at(1))).toBeNull();
  });

  it("lets only the current lease token renew, record and finish a run", async () => {
    const { operation } = await store.propose(change(), T0);
    const token = (await store.start(operation.id, A, at(1_000)))!.operation.leaseOwner!;
    expect(token).toMatch(/^task-a:[0-9a-f]{16}$/);
    // The same holder name with another token (a second run of the same process) is a stranger.
    const stranger = "task-a:0000000000000000";
    expect(await store.renewLease(operation.id, stranger, 60_000, at(2_000))).toBe(false);
    expect(await store.recordStep(operation.id, stranger, step(1))).toBe(false);
    expect(await store.finish(operation.id, stranger, { status: "done", result: null }, T0)).toBe(
      false,
    );
    expect(await store.renewLease(operation.id, token, 60_000, at(2_000))).toBe(true);
    // A replayed step replaces its record; the cursor never goes back.
    expect(await store.recordStep(operation.id, token, step(1))).toBe(true);
    expect(await store.recordStep(operation.id, token, step(2))).toBe(true);
    expect(await store.recordStep(operation.id, token, step(1, 409))).toBe(true);
    const recorded = await store.find(operation.id);
    expect(recorded?.stepCursor).toBe(2);
    expect(recorded?.steps.map((entry) => [entry.step, entry.statusCode])).toEqual([
      [2, 200],
      [1, 409],
    ]);
    await expect(store.recordStep(operation.id, token, step(21))).rejects.toThrow(
      AiOperationStoreError,
    );
    await expect(
      store.finish(operation.id, token, { status: "failed", errorCode: "Not A Code" }, T0),
    ).rejects.toThrow(AiOperationStoreError);
    // An answer too large to keep is not kept, also one that only grows too large in the table
    // (its JSON text gains a space after every comma); the change still counts as done.
    expect(
      await store.finish(
        operation.id,
        token,
        { status: "done", result: { items: Array.from({ length: 12_000 }, () => 1) } },
        at(3_000),
      ),
    ).toBe(true);
    expect(await store.find(operation.id)).toMatchObject({
      status: "done",
      result: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: at(3_000).toISOString(),
    });
  });

  it("takes over a run whose lease ran out exactly once; the stale worker can't write", async () => {
    const { operation } = await store.propose(change(), T0);
    const stale = (await store.start(operation.id, { holder: "task-a", ms: 1_000 }, T0))!.operation
      .leaseOwner!;
    expect((await store.takeOverExpired(B, at(500), 50)).map((row) => row.id)).not.toContain(
      operation.id,
    );
    const [byB, byC] = await Promise.all([
      store.takeOverExpired(B, at(2_000), 50),
      store.takeOverExpired({ holder: "task-c", ms: 60_000 }, at(2_000), 50),
    ]);
    const takers = [byB, byC].filter((rows) => rows.some((row) => row.id === operation.id));
    expect(takers).toHaveLength(1);
    const taken = takers[0]!.find((row) => row.id === operation.id)!;
    expect(taken).toMatchObject({ status: "running", attempts: 2, id: operation.id });
    expect(taken.leaseOwner).not.toBe(stale);
    // The same id, so the same step keys: the route answers the run's first request again.
    expect(await store.renewLease(operation.id, stale, 60_000, at(2_500))).toBe(false);
    expect(await store.recordStep(operation.id, stale, step(1))).toBe(false);
    expect(
      await store.finish(operation.id, stale, { status: "done", result: null }, at(3_000)),
    ).toBe(false);
    expect(
      await store.finish(
        operation.id,
        taken.leaseOwner!,
        { status: "done", result: {} },
        at(3_000),
      ),
    ).toBe(true);
  });

  it("gives up a run that keeps running out of its lease", async () => {
    const { operation } = await store.propose(change(), T0);
    await store.start(operation.id, { holder: "task-a", ms: 1 }, T0);
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
      const taken = await store.takeOverExpired({ holder: "task-b", ms: 1 }, at(attempt * 10), 500);
      expect(taken.find((row) => row.id === operation.id)?.attempts).toBe(attempt);
    }
    const last = await store.takeOverExpired(B, at(1_000), 500);
    expect(last.map((row) => row.id)).not.toContain(operation.id);
    expect(await store.find(operation.id)).toMatchObject({
      status: "failed",
      errorCode: "gave_up",
      attempts: MAX_ATTEMPTS,
      leaseOwner: null,
    });
  });

  it("tells every retry about a run that gave up: nobody knows if it changed something", async () => {
    const asked = change();
    const { operation } = await store.propose(asked, T0);
    await store.start(operation.id, { holder: "task-a", ms: 1 }, T0);
    for (let attempt = 2; attempt <= MAX_ATTEMPTS + 1; attempt++) {
      await store.takeOverExpired({ holder: "task-b", ms: 1 }, at(attempt * 10), 500);
    }
    expect((await store.find(operation.id))?.errorCode).toBe("gave_up");
    expect(
      await store.propose({ ...asked, requestScope: "turn-9" }, at(60 * 60_000)),
    ).toMatchObject({ created: false, operation: { id: operation.id, errorCode: "gave_up" } });
  });

  it("closes changes nobody answered in time", async () => {
    const { operation } = await store.propose(change(), T0);
    await store.expirePending(at(PENDING_ANSWER_MS - 1), 1_000);
    expect((await store.find(operation.id))?.status).toBe("pending");
    await store.expirePending(at(PENDING_ANSWER_MS), 1_000);
    expect(await store.find(operation.id)).toMatchObject({
      status: "closed",
      closeReason: "expired",
      finishedAt: at(PENDING_ANSWER_MS).toISOString(),
    });
  });

  it("refuses a row whose state doesn't add up, without the row in the error", async () => {
    const { operation } = await store.propose(change(), T0);
    await expect(
      admin.query(`UPDATE platform.ai_operations SET status = 'done' WHERE id = $1::uuid`, [
        operation.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      admin.query(
        `UPDATE platform.ai_operations SET connection_id = gen_random_uuid() WHERE id = $1::uuid`,
        [operation.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const secret = "guest wrote: room 12 smells";
    const error = await store
      .propose(change({ client: "not a client", arguments: { propertyId: PROPERTY, secret } }), T0)
      .then(
        () => null,
        (caught: unknown) => caught as AiOperationStoreError,
      );
    expect(error).toBeInstanceOf(AiOperationStoreError);
    expect(error).toMatchObject({ code: "23514" });
    expect(JSON.stringify({ ...error, message: error?.message })).not.toContain(secret);
  });

  it("goes with its property", async () => {
    const property = randomUUID();
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, $2, 'AI changes hotel 2')`,
      [property, `ai-changes-${property}`],
    );
    const asked = change({ propertyId: property });
    const { operation } = await store.propose(
      { ...asked, arguments: { ...asked.arguments, propertyId: property } },
      T0,
    );
    await admin.query(`DELETE FROM hotel_catalog.properties WHERE id = $1::uuid`, [property]);
    expect(await store.find(operation.id)).toBeNull();
  });

  it("deletes changes after 90 days, with the text their arguments carry", async () => {
    const retention = createPgAiActionLogRetentionStore({ connectionString: URL_!, max: 1 });
    const dbNow = (await admin.query<{ now: Date }>("SELECT now()")).rows[0]!.now.getTime();
    const day = 24 * 60 * 60_000;
    const old = await store.propose(change(), new Date(dbNow - 91 * day));
    const recent = await store.propose(change(), new Date(dbNow - 89 * day));
    try {
      // The database is shared with other suites: drain, then check only this suite's rows.
      let purged: number;
      do purged = (await retention.purgeExpiredBatch(new Date(dbNow), 1_000)).operations;
      while (purged > 0);
      expect(await store.find(old.operation.id)).toBeNull();
      expect(await store.find(recent.operation.id)).not.toBeNull();
    } finally {
      await retention.close();
    }
  });
});
