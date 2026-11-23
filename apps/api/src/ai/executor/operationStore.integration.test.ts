// The record of every AI change on PostgreSQL (VAY-2524): one row per change, found again by a
// retried tool call, started by exactly one caller, taken over once when its lease runs out, and
// deleted with its retention.
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgAiActionLogRetentionStore } from "../actionLog/aiActivity.js";
import {
  canonicalJson,
  createPgAiOperationStore,
  operationBusinessKey,
  PENDING_ANSWER_MS,
  SAME_CHANGE_MS,
  type ProposedChange,
} from "./operationStore.js";

const URL_ = process.env["TEST_DATABASE_URL"];
const ORG = randomUUID();
const PROPERTY = randomUUID();
const USER = randomUUID();
const CONVERSATION = randomUUID();
const T0 = new Date("2026-12-01T09:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const A = { owner: "task-a:1", ms: 60_000 };
const B = { owner: "task-b:1", ms: 60_000 };

let seq = 0;
/** A change with arguments of its own, so tests don't find each other's rows. */
function change(overrides: Partial<ProposedChange> = {}): ProposedChange {
  return {
    organizationId: ORG,
    propertyId: PROPERTY,
    userId: USER,
    surface: "in_app",
    conversationId: CONVERSATION,
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

describe("the business key (VAY-2524)", () => {
  it("is the same for the same change, whatever the key order, and differs otherwise", () => {
    const base = change();
    const reordered = {
      ...base,
      arguments: Object.fromEntries(Object.entries(base.arguments).reverse()),
    };
    expect(operationBusinessKey(reordered)).toBe(operationBusinessKey(base));
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
});

describe.skipIf(!URL_)("AI operations on PostgreSQL (VAY-2524)", () => {
  const admin = new pg.Client({ connectionString: URL_ });
  const store = createPgAiOperationStore({ connectionString: URL_ ?? "", max: 6 });

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

  it("writes an Ask-first change as pending, waiting 15 minutes for the answer", async () => {
    const asked = change();
    const { operation, created } = await store.propose(asked, T0);
    expect(created).toBe(true);
    expect(operation).toMatchObject({
      status: "pending",
      group: "ask",
      action: "thread_mark_done",
      actionVersion: 1,
      surface: "in_app",
      conversationId: CONVERSATION,
      connectionId: null,
      businessKey: operationBusinessKey(asked),
      arguments: asked.arguments,
      expiresAt: at(PENDING_ANSWER_MS).toISOString(),
      attempts: 0,
      steps: [],
    });
  });

  it("gives a retried or regenerated tool call the same change, never a second one", async () => {
    const asked = change();
    const first = await store.propose(asked, T0);
    const again = await store.propose(
      { ...asked, arguments: Object.fromEntries(Object.entries(asked.arguments).reverse()) },
      at(5_000),
    );
    expect(again).toEqual({ operation: first.operation, created: false });
    const other = await store.propose(
      { ...asked, arguments: { ...asked.arguments, expectedThreadVersion: 1_000 } },
      at(5_000),
    );
    expect(other.created).toBe(true);
  });

  it("writes one change for copies of a tool call sent at once", async () => {
    const asked = change();
    const results = await Promise.all(Array.from({ length: 5 }, () => store.propose(asked, T0)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.operation.id)).size).toBe(1);
    const rows = await admin.query(
      `SELECT count(*)::int AS n FROM platform.ai_operations WHERE business_key = $1`,
      [operationBusinessKey(asked)],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("asks again after a No, an expiry or an hour; a done change is found within the hour", async () => {
    const asked = change();
    const declined = await store.propose(asked, T0);
    expect(await store.closePending(declined.operation.id, "declined", at(1_000))).toMatchObject({
      status: "closed",
      closeReason: "declined",
    });
    const second = await store.propose(asked, at(2_000));
    expect(second.created).toBe(true);
    // Unanswered past its expiry: a new question, not a dead card.
    const third = await store.propose(asked, at(2_000 + PENDING_ANSWER_MS));
    expect(third.created).toBe(true);
    const started = await store.start(third.operation.id, A, at(2_000 + PENDING_ANSWER_MS));
    expect(started?.won).toBe(true);
    const finishedAt = at(3_000 + PENDING_ANSWER_MS);
    expect(
      await store.finish(
        third.operation.id,
        A.owner,
        { status: "done", result: { ok: 1 } },
        finishedAt,
      ),
    ).toBe(true);
    const found = await store.propose(asked, at(SAME_CHANGE_MS));
    expect(found).toMatchObject({
      created: false,
      operation: { id: third.operation.id, status: "done", result: { ok: 1 } },
    });
    expect(
      (await store.propose(asked, at(4_000 + PENDING_ANSWER_MS + SAME_CHANGE_MS))).created,
    ).toBe(true);
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
      operation: { id: operation.id, status: "running" },
    });
    expect(await store.start(randomUUID(), A, at(1_000))).toBeNull();
  });

  it("never starts a change that expired or was closed", async () => {
    const expired = await store.propose(change(), T0);
    expect(await store.start(expired.operation.id, A, at(PENDING_ANSWER_MS))).toMatchObject({
      won: false,
      operation: { status: "pending" },
    });
    const closed = await store.propose(change(), T0);
    await store.closePending(closed.operation.id, "revoked", at(1_000));
    expect(await store.start(closed.operation.id, A, at(2_000))).toMatchObject({
      won: false,
      operation: { status: "closed", closeReason: "revoked" },
    });
    expect(await store.closePending(closed.operation.id, "declined", at(3_000))).toBeNull();
  });

  it("lets only the run's lease holder renew, record and finish it", async () => {
    const { operation } = await store.propose(change(), T0);
    await store.start(operation.id, A, at(1_000));
    const step = {
      step: 1,
      requestId: randomUUID(),
      idempotencyKeySha256: "a".repeat(64),
      statusCode: 200,
      at: at(2_000).toISOString(),
    };
    expect(await store.renewLease(operation.id, B, at(2_000))).toBe(false);
    expect(await store.recordStep(operation.id, B.owner, step)).toBe(false);
    expect(
      await store.finish(operation.id, B.owner, { status: "failed", errorCode: "x" }, T0),
    ).toBe(false);
    expect(await store.renewLease(operation.id, A, at(2_000))).toBe(true);
    expect(await store.recordStep(operation.id, A.owner, step)).toBe(true);
    expect(
      await store.finish(
        operation.id,
        A.owner,
        { status: "failed", errorCode: "changed" },
        at(3_000),
      ),
    ).toBe(true);
    expect(await store.find(operation.id)).toMatchObject({
      status: "failed",
      errorCode: "changed",
      stepCursor: 1,
      steps: [step],
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: at(3_000).toISOString(),
    });
    expect(await store.finish(operation.id, A.owner, { status: "done", result: null }, T0)).toBe(
      false,
    );
  });

  it("takes over a run whose lease ran out exactly once; the stale worker can't finish it", async () => {
    const { operation } = await store.propose(change(), T0);
    await store.start(operation.id, { owner: A.owner, ms: 1_000 }, T0);
    const before = await store.takeOverExpired(B, at(500), 50);
    expect(before.map((row) => row.id)).not.toContain(operation.id);
    const [byB, byC] = await Promise.all([
      store.takeOverExpired(B, at(2_000), 50),
      store.takeOverExpired({ owner: "task-c:1", ms: 60_000 }, at(2_000), 50),
    ]);
    const takers = [byB, byC].filter((rows) => rows.some((row) => row.id === operation.id));
    expect(takers).toHaveLength(1);
    const taken = takers[0]!.find((row) => row.id === operation.id)!;
    expect(taken).toMatchObject({ status: "running", attempts: 2, id: operation.id });
    // The same id, so the same step keys: the route answers the run's first request again.
    expect(
      await store.finish(operation.id, A.owner, { status: "done", result: null }, at(3_000)),
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

  it("closes changes nobody answered in time", async () => {
    const { operation } = await store.propose(change(), T0);
    expect(await store.expirePending(at(PENDING_ANSWER_MS - 1), 1_000)).toBeGreaterThanOrEqual(0);
    expect((await store.find(operation.id))?.status).toBe("pending");
    expect(await store.expirePending(at(PENDING_ANSWER_MS), 1_000)).toBeGreaterThanOrEqual(1);
    expect(await store.find(operation.id)).toMatchObject({
      status: "closed",
      closeReason: "expired",
      finishedAt: at(PENDING_ANSWER_MS).toISOString(),
    });
  });

  it("refuses a row whose state doesn't add up", async () => {
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
