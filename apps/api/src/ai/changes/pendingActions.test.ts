// Who may answer an AI change, and what a Yes or No does (VAY-2524), on the real auth plugin with
// the test world's people: only the person the AI asked, in a vayada app, with the rights now.
import { randomUUID } from "node:crypto";

import { backendAuthPlugin, createFakeVerifier, type PermissionKey } from "@vayada/backend-auth";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { WORLD, worldAuthorization, worldIdentity } from "../actions/actionTestWorld.fixtures.js";
import type {
  AiOperation,
  AiOperationCloseReason,
  AiOperationStore,
} from "../executor/operationStore.js";
import { CardReadError, cardSha256, type CardReader } from "./changeCard.js";
import {
  pendingActionView,
  registerPendingActionRoutes,
  stateOf,
  type PendingActionView,
} from "./pendingActions.js";

const { OWNER, MEMBER, ORG_A, ORG_B, P1, P2, CONVERSATION } = WORLD;
const ORIGIN = "https://pms.example.test";
const DELUXE = "eeeeeeee-0000-4000-8000-000000000001";
const R12 = "ffffffff-0000-4000-8000-000000000012";
const NOW = new Date("2026-12-09T09:40:00Z");
const LATER = "2026-12-09T09:55:00.000Z";

function operation(overrides: Partial<AiOperation> = {}): AiOperation {
  return {
    id: randomUUID(),
    organizationId: ORG_A,
    propertyId: P1,
    userId: OWNER,
    surface: "in_app",
    connectionId: null,
    conversationId: CONVERSATION,
    requestScope: "turn-1",
    client: "vayada:pms",
    action: "room_block_create",
    actionVersion: 1,
    group: "ask",
    businessKey: "key",
    arguments: {
      propertyId: P1,
      roomTypeId: DELUXE,
      roomIds: [R12],
      startsOn: "2026-12-12",
      endsOn: "2026-12-14",
    },
    status: "pending",
    closeReason: null,
    expiresAt: LATER,
    previewSha256: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    attempts: 0,
    stepCursor: 0,
    steps: [],
    result: null,
    errorCode: null,
    createdAt: "2026-12-09T09:40:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function memoryStore(...operations: AiOperation[]) {
  const rows = new Map(operations.map((row) => [row.id, row]));
  const store: Pick<AiOperationStore, "find" | "closePending"> = {
    async find(id) {
      return rows.get(id) ?? null;
    },
    async closePending(id, reason: AiOperationCloseReason, now) {
      const row = rows.get(id);
      if (!row || row.status !== "pending") return null;
      const expired = row.expiresAt !== null && Date.parse(row.expiresAt) <= now.getTime();
      const closed: AiOperation = {
        ...row,
        status: "closed",
        closeReason: expired ? "expired" : reason,
        finishedAt: now.toISOString(),
      };
      rows.set(id, closed);
      return closed;
    },
  };
  return { store, rows };
}

const readerOf = (overrides: Partial<CardReader> = {}): CardReader => ({
  rooms: async () => [{ roomId: R12, roomTypeId: DELUXE, roomNumber: "12", status: "available" }],
  roomTypeNames: async () => new Map([[DELUXE, "Deluxe Double"]]),
  roomBlock: async () => null,
  linkedRoomTypeIds: async () => [],
  thread: async () => null,
  booking: async () => null,
  ...overrides,
});

const session = (workosUserId: string, workosOrgId: string, sessionId: string | null) => ({
  workosUserId,
  workosOrgId,
  sessionId,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});
const TOKENS = new Map([
  ["owner", session(`wos_${OWNER}`, "org_wos_a", "session_owner")],
  ["owner-machine", session(`wos_${OWNER}`, "org_wos_a", null)],
  ["member", session(`wos_${MEMBER}`, "org_wos_a", "session_member")],
  // Staff signed in as the owner through WorkOS impersonation (the token's `act` claim).
  [
    "owner-impersonated",
    {
      ...session(`wos_${OWNER}`, "org_wos_a", "session_impersonated"),
      impersonated: true as const,
    },
  ],
]);
const CALENDAR: PermissionKey[] = ["pms.calendar.manage", "pms.calendar.read"];

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setUp(
  operations: AiOperation[],
  options: {
    permissions?: PermissionKey[];
    aiOn?: boolean;
    channelActive?: boolean;
    reader?: CardReader;
    afterRun?: (row: AiOperation) => AiOperation;
    /** Instead of aiOn: may also change rows, as another tab would meanwhile. */
    aiEnabled?: (rows: Map<string, AiOperation>) => Promise<boolean>;
    startFails?: boolean;
    findFails?: boolean;
  } = {},
) {
  const memory = memoryStore(...operations);
  const { rows } = memory;
  const store: typeof memory.store = options.findFails
    ? {
        ...memory.store,
        find: async () => {
          throw new Error("AI operation store query failed (57014)");
        },
      }
    : memory.store;
  const starts: string[] = [];
  const world = worldAuthorization(options.permissions ?? CALENDAR);
  app = Fastify({ logger: false });
  await app.register(backendAuthPlugin, {
    verifier: createFakeVerifier(TOKENS),
    repository: worldIdentity,
    authorizationResolver: world.resolver,
  });
  await app.register(registerPendingActionRoutes, {
    prefix: "/api/ai",
    root: app,
    store,
    async startAndRun(id) {
      starts.push(id);
      if (options.startFails) throw new Error("AI operation store query failed (57P01)");
      const row = rows.get(id);
      if (!row || row.status !== "pending") return row ?? null;
      const ran = (options.afterRun ?? ((r) => ({ ...r, status: "done" as const })))({
        ...row,
        status: "running",
        startedAt: NOW.toISOString(),
      });
      rows.set(id, ran);
      return ran;
    },
    aiEnabled: async () => (options.aiEnabled ? options.aiEnabled(rows) : (options.aiOn ?? true)),
    channelActive: async () => options.channelActive ?? true,
    allowedOrigins: [ORIGIN],
    reader: () => options.reader ?? readerOf(),
    now: () => NOW,
  });
  await app.ready();
  const headers = (token: string, origin: string | null) => ({
    authorization: `Bearer ${token}`,
    ...(origin ? { origin } : {}),
  });
  return {
    rows,
    starts,
    get: (id: string, token = "owner", origin: string | null = ORIGIN) =>
      app!.inject({
        method: "GET",
        url: `/api/ai/pending-actions/${id}`,
        headers: headers(token, origin),
      }),
    answer: (id: string, body: unknown, token = "owner", origin: string | null = ORIGIN) =>
      app!.inject({
        method: "POST",
        url: `/api/ai/pending-actions/${id}/answer`,
        headers: headers(token, origin),
        payload: body as Record<string, unknown>,
      }),
  };
}

describe("answering AI changes (VAY-2524)", () => {
  it("shows the waiting change with vayada's card and the digest a Yes must send", async () => {
    const op = operation();
    const { get } = await setUp([op]);
    const response = await get(op.id);
    expect(response.statusCode).toBe(200);
    const view = response.json<PendingActionView>();
    expect(view).toMatchObject({
      id: op.id,
      state: "needs_answer",
      answerBy: LATER,
      answeredAt: null,
      card: { question: "Block room 12 for 3 nights?", yesLabel: "Yes, block room 12" },
    });
    expect(view.cardSha256).toBe(cardSha256(op, view.card!));
  });

  it("answers only the person's own vayada session, from a vayada app", async () => {
    const op = operation();
    const { get, answer, starts } = await setUp([op]);
    const sha = (await get(op.id)).json<PendingActionView>().cardSha256;
    for (const [token, origin] of [
      ["owner-machine", ORIGIN],
      ["owner", null],
      ["owner", "https://evil.example.test"],
    ] as const) {
      const response = await answer(op.id, { answer: "yes", cardSha256: sha }, token, origin);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "first_party_only" });
      expect((await get(op.id, token, origin)).statusCode).toBe(403);
    }
    // Someone else in the account, and the person while another account is selected.
    const member = await answer(op.id, { answer: "yes", cardSha256: sha }, "member");
    expect(member.statusCode).toBe(403);
    expect(member.json()).toMatchObject({ code: "not_your_change" });
    expect((await get(op.id, "member")).json()).toMatchObject({ code: "not_your_change" });
    expect((await answer(op.id, { answer: "no" }, "member")).statusCode).toBe(403);
    expect((await get(randomUUID())).json()).toMatchObject({ code: "not_found" });
    expect((await get("not-a-uuid")).statusCode).toBe(404);
    expect(
      (await app!.inject({ method: "GET", url: `/api/ai/pending-actions/${op.id}` })).statusCode,
    ).toBe(401);
    expect(starts).toEqual([]);
  });

  it("lets staff signed in as the person see the card but never answer it", async () => {
    const op = operation();
    const { get, answer, starts, rows } = await setUp([op]);
    const seen = await get(op.id, "owner-impersonated");
    expect(seen.statusCode).toBe(200);
    // The same card, without the digest a Yes needs: this session can't answer it.
    expect(seen.json()).toMatchObject({
      state: "needs_answer",
      card: { question: "Block room 12 for 3 nights?" },
      cardSha256: null,
    });
    const sha = (await get(op.id)).json<PendingActionView>().cardSha256;
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    for (const body of [{ answer: "yes", cardSha256: sha }, { answer: "no" }]) {
      const response = await answer(op.id, body, "owner-impersonated");
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: "impersonated",
        message: "You're signed in as someone else. Only they can answer.",
      });
    }
    expect(starts).toEqual([]);
    expect(rows.get(op.id)).toMatchObject({ status: "pending" });
    // The person's own session still answers the same card.
    const own = await answer(op.id, { answer: "yes", cardSha256: sha });
    expect(own.statusCode).toBe(200);
    expect(starts).toEqual([op.id]);
  });

  it("refuses a change of another account the person is not in right now", async () => {
    const op = operation({ organizationId: ORG_B });
    const { get } = await setUp([op]);
    expect((await get(op.id)).json()).toMatchObject({ statusCode: 403, code: "other_account" });
  });

  it("runs a Yes through the executor, once, and keeps the card the person said yes to", async () => {
    const op = operation();
    const { get, answer, starts, rows } = await setUp([op]);
    const { cardSha256: sha, card } = (await get(op.id)).json<PendingActionView>();
    const response = await answer(op.id, { answer: "yes", cardSha256: sha });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "done",
      card,
      cardSha256: null,
      answerBy: null,
      answeredAt: NOW.toISOString(),
    });
    expect(starts).toEqual([op.id]);
    // Answered: a second Yes or a No changes nothing.
    const again = await answer(op.id, { answer: "yes", cardSha256: sha });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      code: "already_answered",
      pendingAction: { state: "done" },
    });
    expect((await answer(op.id, { answer: "no" })).json()).toMatchObject({
      code: "already_answered",
    });
    expect(starts).toEqual([op.id]);
    expect(rows.get(op.id)!.status).toBe("done");
  });

  it("needs the card's digest with a Yes, and refuses a card that reads differently now", async () => {
    const op = operation();
    const { answer, starts, rows } = await setUp([op]);
    for (const body of [
      { answer: "yes" },
      { answer: "yes", cardSha256: "short" },
      { answer: "maybe" },
      { answer: "yes", cardSha256: "a".repeat(64), extra: true },
      [],
    ]) {
      const response = await answer(op.id, body);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "invalid_body" });
    }
    expect(rows.get(op.id)!.status).toBe("pending");
    const stale = await answer(op.id, { answer: "yes", cardSha256: "a".repeat(64) });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "changed", pendingAction: { state: "changed" } });
    expect(rows.get(op.id)).toMatchObject({ status: "closed", closeReason: "changed" });
    expect(starts).toEqual([]);
  });

  it("closes a change whose room is gone, and refuses its Yes", async () => {
    const op = operation();
    const { get, answer, rows, starts } = await setUp([op], {
      reader: readerOf({ rooms: async () => [] }),
    });
    expect((await get(op.id)).json()).toMatchObject({ state: "changed", card: null });
    expect(rows.get(op.id)).toMatchObject({ status: "closed", closeReason: "changed" });
    expect(
      (await answer(op.id, { answer: "yes", cardSha256: "a".repeat(64) })).json(),
    ).toMatchObject({ code: "already_answered", pendingAction: { state: "changed" } });
    expect(starts).toEqual([]);
  });

  it("refuses an expired question and closes it as expired", async () => {
    const op = operation({ expiresAt: "2026-12-09T09:39:59.000Z" });
    const { get, answer, rows, starts } = await setUp([op]);
    expect((await get(op.id)).json()).toMatchObject({ state: "expired", cardSha256: null });
    const yes = await answer(op.id, { answer: "yes", cardSha256: "a".repeat(64) });
    expect(yes.statusCode).toBe(409);
    expect(yes.json()).toMatchObject({ code: "expired", pendingAction: { state: "expired" } });
    expect(rows.get(op.id)).toMatchObject({ status: "closed", closeReason: "expired" });
    const no = await answer(op.id, { answer: "no" });
    expect(no.json()).toMatchObject({ code: "expired" });
    expect(starts).toEqual([]);
  });

  it("an expired question can't be declined either", async () => {
    const op = operation({ expiresAt: "2026-12-09T09:39:59.000Z" });
    const { answer, rows } = await setUp([op]);
    const no = await answer(op.id, { answer: "no" });
    expect(no.statusCode).toBe(409);
    expect(no.json()).toMatchObject({ code: "expired" });
    expect(rows.get(op.id)).toMatchObject({ status: "closed", closeReason: "expired" });
  });

  it("closes the question when AI is off for the account or the AI's connection is gone", async () => {
    const off = operation();
    const first = await setUp([off], { aiOn: false });
    expect((await first.get(off.id)).json()).toMatchObject({ state: "stopped" });
    expect(first.rows.get(off.id)).toMatchObject({ closeReason: "ai_switched_off" });
    await app!.close();
    app = undefined;

    const mcp = operation({ surface: "mcp", connectionId: CONVERSATION, conversationId: null });
    const second = await setUp([mcp], { channelActive: false });
    const yes = await second.answer(mcp.id, { answer: "yes", cardSha256: "a".repeat(64) });
    expect(yes.statusCode).toBe(409);
    expect(yes.json()).toMatchObject({ code: "revoked", pendingAction: { state: "stopped" } });
    expect(second.rows.get(mcp.id)).toMatchObject({ closeReason: "revoked" });
    expect(second.starts).toEqual([]);
  });

  it("refuses a Yes the person's rights no longer allow, leaving the question open", async () => {
    const op = operation();
    const { get, answer, rows, starts } = await setUp([op], { permissions: ["pms.calendar.read"] });
    const view = (await get(op.id)).json<PendingActionView>();
    expect(view).toMatchObject({ state: "not_allowed", cardSha256: null });
    const yes = await answer(op.id, { answer: "yes", cardSha256: "a".repeat(64) });
    expect(yes.statusCode).toBe(403);
    expect(yes.json()).toMatchObject({ code: "not_allowed" });
    expect(rows.get(op.id)!.status).toBe("pending");
    // A No is always fine.
    expect((await answer(op.id, { answer: "no" })).json()).toMatchObject({ state: "declined" });
    expect(starts).toEqual([]);
  });

  it("refuses a Yes on a property outside the person's access", async () => {
    // The member may use P1 only.
    const op = operation({ userId: MEMBER, propertyId: P2, arguments: { propertyId: P2 } });
    const { answer } = await setUp([op]);
    const yes = await answer(op.id, { answer: "yes", cardSha256: "a".repeat(64) }, "member");
    expect(yes.json()).toMatchObject({ code: "not_allowed" });
  });

  it("answers 'not allowed' when the person can't read what the card names, 503 when reads fail", async () => {
    const hidden = operation();
    const first = await setUp([hidden], {
      reader: readerOf({
        rooms: async () => {
          throw new CardReadError("not_allowed");
        },
      }),
    });
    expect((await first.get(hidden.id)).json()).toMatchObject({ state: "not_allowed", card: null });
    expect(first.rows.get(hidden.id)!.status).toBe("pending");
    await app!.close();
    app = undefined;

    const broken = operation();
    const second = await setUp([broken], {
      reader: readerOf({
        rooms: async () => {
          throw new CardReadError("unavailable");
        },
      }),
    });
    const response = await second.get(broken.id);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "unavailable" });
    expect(second.rows.get(broken.id)!.status).toBe("pending");
  });

  it("takes a No once", async () => {
    const op = operation();
    const { answer, rows, starts } = await setUp([op]);
    const no = await answer(op.id, { answer: "no" });
    expect(no.statusCode).toBe(200);
    expect(no.json()).toMatchObject({ state: "declined", answeredAt: NOW.toISOString() });
    expect(rows.get(op.id)).toMatchObject({ status: "closed", closeReason: "declined" });
    expect((await answer(op.id, { answer: "no" })).statusCode).toBe(409);
    expect(starts).toEqual([]);
  });

  it("says a question was answered when another tab answered it meanwhile, not why it closes", async () => {
    const op = operation();
    const { answer, rows, starts } = await setUp([op], {
      // AI goes off while another tab's Yes starts the change.
      aiEnabled: async (current) => {
        current.set(op.id, { ...op, status: "running", startedAt: LATER, leaseOwner: "other" });
        return false;
      },
    });
    const yes = await answer(op.id, { answer: "yes", cardSha256: "a".repeat(64) });
    expect(yes.statusCode).toBe(409);
    expect(yes.json()).toMatchObject({
      code: "already_answered",
      pendingAction: { state: "running" },
    });
    expect(rows.get(op.id)!.status).toBe("running");
    expect(starts).toEqual([]);
  });

  it("answers a failure inside with a plain 'try again', never its detail", async () => {
    const op = operation();
    const { get, answer } = await setUp([op], { startFails: true });
    const { cardSha256: sha } = (await get(op.id)).json<PendingActionView>();
    const yes = await answer(op.id, { answer: "yes", cardSha256: sha });
    expect(yes.statusCode).toBe(503);
    expect(yes.json()).toEqual({
      statusCode: 503,
      code: "unavailable",
      category: "dependency",
      message: "vayada can't do this right now. Try again.",
    });
    await app!.close();
    app = undefined;
    // Looking the change up fails too: the same plain answer.
    const broken = await setUp([op], { findFails: true });
    const look = await broken.get(op.id);
    expect(look.statusCode).toBe(503);
    expect(look.json()).toMatchObject({ code: "unavailable" });
    expect(JSON.stringify(look.json())).not.toContain("57014");
  });

  it("tells each way a change ended", () => {
    const at = (overrides: Partial<AiOperation>) => stateOf(operation(overrides), NOW);
    expect(at({ status: "running" })).toBe("running");
    expect(at({ status: "failed", errorCode: "gave_up" })).toBe("unsure");
    expect(at({ status: "failed", errorCode: "not_allowed" })).toBe("not_allowed");
    expect(at({ status: "failed", errorCode: "thread_version_conflict" })).toBe("changed");
    expect(at({ status: "failed", errorCode: "room_block_conflict" })).toBe("changed");
    expect(at({ status: "failed", errorCode: "ari_changed" })).toBe("changed");
    expect(at({ status: "failed", errorCode: "invalid_input" })).toBe("failed");
    expect(at({ status: "closed", closeReason: "revoked" })).toBe("stopped");
    expect(at({ status: "closed", closeReason: "ai_switched_off" })).toBe("stopped");
    expect(at({ status: "closed", closeReason: "declined" })).toBe("declined");
    expect(at({ expiresAt: "2026-12-09T09:40:00.000Z" })).toBe("expired");
    // A running change's answer time is the Yes.
    expect(
      pendingActionView(operation({ status: "running", startedAt: LATER }), null, NOW),
    ).toMatchObject({ state: "running", answeredAt: LATER, answerBy: null, cardSha256: null });
  });
});
