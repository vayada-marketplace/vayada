// The person's Yes/No to an AI change on real PostgreSQL (VAY-2524): real identity, roles,
// entitlements and property scope, the real inbox routes and commands, the real operation store
// and the one executor. An AI asks; only the person, signed in to a vayada app, answers; a Yes runs
// the change once; a stale card, an expired question, a person's edit, AI switched off and every
// AI token are refused without changing anything.
import { createHash, randomUUID } from "node:crypto";

import {
  createFakeVerifier,
  createPgIdentityRepository,
  injectAsDelegate,
  resolveDelegatedChangeContext,
  resolveDelegatedContext,
  type IdentityRepository,
  type VerifiedSession,
} from "@vayada/backend-auth";
import {
  createAuthorizationResolver,
  createPgEntitlementRepository,
  createPgPropertyAccessRepository,
  createPgRolePermissionRepository,
} from "@vayada/backend-authorization";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../../app.js";
import { createPgPmsInboxReadPort } from "../../domains/pmsInboxReadModel.js";
import { createPgPmsInboxTriagePort } from "../../domains/pmsInboxTriageCommand.js";
import { memoryAiActionLog } from "../actionLog/memoryActionLog.fixtures.js";
import { ACTION_FIXTURES } from "../actions/actionFixtures.fixtures.js";
import type { ChangeAction } from "../actions/defineChangeAction.js";
import { threadMarkDone } from "../actions/threadTriage.js";
import { createAiChangeExecutor, type AiChangeExecutor } from "../executor/executor.js";
import { createPgAiOperationStore } from "../executor/operationStore.js";
import type { PendingActionView } from "./pendingActions.js";
import { createAiChangeProposer } from "./proposeChange.js";

const url = process.env["TEST_DATABASE_URL"];
const PREFIX = `vay2524-answer-${randomUUID().slice(0, 8)}`;
const org = randomUUID();
const property = randomUUID();
const user = randomUUID();
const conversation = randomUUID();
const ORIGIN = "https://pms.example.test";
const DISABLED = "postgresql://integration-test-disabled";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!url)("the Yes/No to AI changes on PostgreSQL (VAY-2524)", () => {
  const admin = new pg.Client({ connectionString: url });
  const store = createPgAiOperationStore({ connectionString: url ?? DISABLED, max: 4 });
  const triage = createPgPmsInboxTriagePort({ connectionString: url ?? DISABLED, max: 4 });
  const inboxRead = createPgPmsInboxReadPort({
    connectionString: url ?? DISABLED,
    max: 2,
    attachmentMediaAccessEnabled: false,
    emailReplyRoutes: {
      async resolveReplyRoutes() {
        return [];
      },
    },
  });
  const log = memoryAiActionLog();
  const failures: unknown[] = [];
  let aiOn = true;
  let app: ReturnType<typeof buildApp>;
  let identity: IdentityRepository;
  let authorizationResolver: ReturnType<typeof createAuthorizationResolver>;
  let executor: AiChangeExecutor;
  const starts: string[] = [];

  // The person's own browser session, and the same person through a token without one (an API
  // key or machine token).
  const session = (sessionId: string | null): VerifiedSession => ({
    workosUserId: `wk-user-${PREFIX}`,
    workosOrgId: `wk-${PREFIX}`,
    sessionId,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  const tokens = new Map([
    ["person", session("session_person")],
    ["machine", session(null)],
  ]);

  // The tool layer's offer: thread_mark_done is not offered anywhere yet (AI stays off).
  const inApp = { ...threadMarkDone, surfaces: ["in_app"] } as ChangeAction;
  const proposeChange = createAiChangeProposer({
    store,
    log,
    onLogFailure: (error) => failures.push(error),
    findAction: (key) => (key === inApp.key ? inApp : undefined),
  });
  const toolContext = () =>
    resolveDelegatedContext(
      identity,
      {
        userId: user,
        organizationId: org,
        delegation: { channel: "in_app", conversationId: conversation, toolCallId: randomUUID() },
      },
      { authorizationResolver },
    );

  beforeAll(async () => {
    const endpoint = new URL(url!);
    if (
      !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
      !/(^|[_-])test([_-]|$)/i.test(endpoint.pathname.slice(1))
    )
      throw new Error("Local test DB required");
    await admin.connect();
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, workos_org_id)
       VALUES ($1::uuid, 'hotel_group', $2, $2, $3)`,
      [org, PREFIX, `wk-${PREFIX}`],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements (organization_id, product, entitlement_key, status)
       VALUES ($1, 'pms', 'property-management', 'active')`,
      [org],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name) VALUES ($1::uuid, $2, $2)`,
      [property, PREFIX],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship)
       VALUES ($1::uuid, 'hotel_catalog', 'property', $2::text, 'owner'),
              ($1::uuid, 'pms', 'pms_property', $2::text, 'owner')`,
      [org, property],
    );
    await admin.query(`INSERT INTO identity.users (id, email) VALUES ($1, $2)`, [
      user,
      `${PREFIX}@example.test`,
    ]);
    await admin.query(
      `INSERT INTO identity.external_identities (user_id, provider, provider_user_id)
       VALUES ($1, 'workos', $2)`,
      [user, `wk-user-${PREFIX}`],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key, access_origin, property_access_mode)
       VALUES ($1, $2, 'active', 'hotel_owner', 'agency', 'all')`,
      [org, user],
    );

    identity = createPgIdentityRepository({ connectionString: url! });
    const auth = {
      verifier: createFakeVerifier(tokens),
      repository: identity,
      rolePermissionRepository: createPgRolePermissionRepository({ connectionString: url! }),
      entitlementRepository: createPgEntitlementRepository({ connectionString: url! }),
      propertyAccessRepository: createPgPropertyAccessRepository({ connectionString: url! }),
    };
    authorizationResolver = createAuthorizationResolver(
      auth.rolePermissionRepository,
      auth.entitlementRepository,
      auth.propertyAccessRepository,
    );
    app = buildApp({
      logger: false,
      ...ACTION_FIXTURES.find((fixture) => fixture.action === "rooms_list@1")!.appOptions(),
      pmsInboxTriagePort: triage,
      pmsInboxReadPort: inboxRead,
      auth,
      browserAllowedOrigins: [ORIGIN],
      aiPendingActions: {
        store,
        startAndRun: (id) => {
          starts.push(id);
          return executor.startAndRun(id);
        },
        aiEnabled: async () => aiOn,
        channelActive: async (operation) => operation.surface === "in_app",
        allowedOrigins: [ORIGIN],
      },
    });
    executor = createAiChangeExecutor({
      app,
      store,
      identity,
      authorizationResolver,
      log,
      holder: "api-test",
      onLogFailure: (error) => failures.push(error),
      onRunFailure: (error) => failures.push(error),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await store.end();
    await triage.close();
    // The app closed the inbox read port it was given.
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await admin.query(`DELETE FROM platform.ai_operations WHERE organization_id = $1`, [org]);
    for (const table of [
      "platform.idempotency_keys",
      "platform.product_audit_events",
      "platform.domain_events",
      "pms.message_threads",
    ])
      await admin.query(`DELETE FROM ${table} WHERE property_id = $1`, [property]);
    for (const table of [
      "identity.organization_memberships",
      "identity.organization_resource_links",
      "identity.product_entitlements",
    ])
      await admin.query(`DELETE FROM ${table} WHERE organization_id = $1`, [org]);
    await admin.query(`DELETE FROM identity.external_identities WHERE user_id = $1`, [user]);
    await admin.query(`DELETE FROM identity.users WHERE id = $1`, [user]);
    await admin.query(`DELETE FROM hotel_catalog.properties WHERE id = $1`, [property]);
    await admin.query(`DELETE FROM identity.organizations WHERE id = $1`, [org]);
    await admin.query("COMMIT");
    await admin.end();
  });

  /** A conversation that needs an answer, at version 4. */
  async function newThread(): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO pms.message_threads
         (id, property_id, source, source_thread_id, attention_state, delivery_channel,
          conversation_context_state, unread_count, version)
       VALUES ($1, $2, 'channex', $3, 'needs_attention', 'ota', 'unlinked', 1, 4)`,
      [id, property, `${PREFIX}-${id}`],
    );
    return id;
  }
  const thread = async (id: string) =>
    (
      await admin.query<{ attentionState: string; version: string }>(
        `SELECT attention_state AS "attentionState", version::text
           FROM pms.message_threads WHERE id = $1`,
        [id],
      )
    ).rows[0];
  const audits = async (threadId: string) =>
    (
      await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM platform.product_audit_events
          WHERE target_resource_type = 'message_thread' AND target_resource_id = $1`,
        [threadId],
      )
    ).rows[0]!.n;

  /** The AI asks to mark a conversation done; the id the card is found by. */
  async function ask(threadId: string): Promise<string> {
    const result = await proposeChange(await toolContext(), {
      action: "thread_mark_done@1",
      arguments: { propertyId: property, threadId, expectedThreadVersion: 4 },
      client: "vayada:pms",
      requestScope: `turn-${threadId}`,
    });
    if (!result.ok) throw new Error(`not proposed: ${result.error.code}`);
    expect(result).toMatchObject({ status: "pending", created: true });
    return result.pendingActionId;
  }

  const headers = (token = "person", origin: string | null = ORIGIN) => ({
    authorization: `Bearer ${token}`,
    ...(origin ? { origin } : {}),
  });
  const card = (id: string, token?: string, origin?: string | null) =>
    app.inject({
      method: "GET",
      url: `/api/ai/pending-actions/${id}`,
      headers: headers(token, origin),
    });
  const answer = (id: string, body: unknown, token?: string, origin?: string | null) =>
    app.inject({
      method: "POST",
      url: `/api/ai/pending-actions/${id}/answer`,
      headers: headers(token, origin),
      payload: body as Record<string, unknown>,
    });
  const shown = async (id: string) => {
    const response = await card(id);
    expect(response.statusCode).toBe(200);
    return response.json<PendingActionView>();
  };

  it("shows vayada's card and runs the change once on Yes, also from two tabs at once", async () => {
    const threadId = await newThread();
    const id = await ask(threadId);
    const view = await shown(id);
    expect(view).toMatchObject({
      id,
      state: "needs_answer",
      surface: "in_app",
      client: "vayada:pms",
      propertyId: property,
      action: "thread_mark_done",
      answeredAt: null,
      card: {
        yesLabel: "Yes, mark it done",
        effects: [
          "It leaves the list of conversations that need an answer.",
          "The guest is not told.",
        ],
      },
    });
    expect(view.card!.question).toMatch(
      /^Mark (the conversation with .+|a guest conversation) as done\?$/,
    );
    expect(view.cardSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(view.answerBy!)).toBeGreaterThan(Date.now());

    const [first, second] = await Promise.all([
      answer(id, { answer: "yes", cardSha256: view.cardSha256 }),
      answer(id, { answer: "yes", cardSha256: view.cardSha256 }),
    ]);
    const views = [first, second].map((response) =>
      response.statusCode === 200
        ? response.json<PendingActionView>()
        : response.json<{ code: string; pendingAction: PendingActionView }>().pendingAction,
    );
    expect(views.map((one) => one.state)).toContain("done");
    expect(await thread(threadId)).toEqual({ attentionState: "done", version: "5" });
    expect(await audits(threadId)).toBe(1);
    const keys = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.idempotency_keys
        WHERE property_id = $1 AND key_hash = $2`,
      [property, sha256(`op_${id}:1:thread_mark_done`)],
    );
    expect(keys.rows[0]!.n).toBe(1);
    // The AI's ask and the one run: two rows, both on the operation.
    expect(log.rows.filter((row) => row.operationId === id)).toEqual([
      expect.objectContaining({ outcome: "ok", group: "ask", recordsChanged: [] }),
      expect.objectContaining({
        outcome: "ok",
        recordsChanged: [{ type: "message_thread", id: threadId }],
      }),
    ]);
    const done = await shown(id);
    expect(done).toMatchObject({ state: "done", answerBy: null, cardSha256: null });
    expect(done.answeredAt).not.toBeNull();
    // A third click later: answered already, nothing runs again.
    const again = await answer(id, { answer: "yes", cardSha256: view.cardSha256 });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "already_answered" });
    expect(await audits(threadId)).toBe(1);
    expect(failures).toEqual([]);
  });

  it("never lets an AI see or answer a change, nor a token without a session or another site", async () => {
    const threadId = await newThread();
    const id = await ask(threadId);
    const { cardSha256 } = await shown(id);
    // The AI's own read delegation, and the executor's kind of change delegation.
    const read = await injectAsDelegate(app, {
      context: await toolContext(),
      method: "GET",
      routeUrl: "/api/ai/pending-actions/:id",
      url: `/api/ai/pending-actions/${id}`,
    });
    expect(read.statusCode).toBe(403);
    const change = await resolveDelegatedChangeContext(
      identity,
      {
        userId: user,
        organizationId: org,
        delegation: { channel: "in_app", conversationId: conversation, toolCallId: randomUUID() },
        propertyIds: [property],
      },
      { authorizationResolver },
    );
    const yes = await injectAsDelegate(app, {
      context: change,
      method: "POST",
      routeUrl: "/api/ai/pending-actions/:id/answer",
      url: `/api/ai/pending-actions/${id}/answer`,
      body: { answer: "yes", cardSha256 },
      idempotencyKey: `test-${randomUUID()}`,
    });
    expect(yes.statusCode).toBe(403);
    for (const response of [
      await answer(id, { answer: "yes", cardSha256 }, "machine"),
      await answer(id, { answer: "yes", cardSha256 }, "person", "https://evil.example.test"),
      await answer(id, { answer: "yes", cardSha256 }, "person", null),
    ]) {
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "first_party_only" });
    }
    expect((await card(id, "machine")).statusCode).toBe(403);
    expect(starts).not.toContain(id);
    expect((await shown(id)).state).toBe("needs_answer");
    expect(await thread(threadId)).toEqual({ attentionState: "needs_attention", version: "4" });
  });

  it("refuses a Yes to a card that reads differently now, and closes it", async () => {
    const threadId = await newThread();
    const id = await ask(threadId);
    await shown(id);
    const response = await answer(id, { answer: "yes", cardSha256: "0".repeat(64) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "changed",
      pendingAction: { state: "changed", cardSha256: null },
    });
    expect(await store.find(id)).toMatchObject({ status: "closed", closeReason: "changed" });
    expect(starts).not.toContain(id);
    expect(await thread(threadId)).toEqual({ attentionState: "needs_attention", version: "4" });
  });

  it("refuses an expired question", async () => {
    const threadId = await newThread();
    const id = await ask(threadId);
    const { cardSha256 } = await shown(id);
    await admin.query(
      `UPDATE platform.ai_operations SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    const response = await answer(id, { answer: "yes", cardSha256 });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "expired", pendingAction: { state: "expired" } });
    expect(await store.find(id)).toMatchObject({ status: "closed", closeReason: "expired" });
    expect(starts).not.toContain(id);
  });

  it("refuses a Yes after a person changed the conversation: nothing is overwritten", async () => {
    const threadId = await newThread();
    const id = await ask(threadId);
    const { cardSha256 } = await shown(id);
    // A person handles the conversation meanwhile.
    await admin.query(`UPDATE pms.message_threads SET version = 5 WHERE id = $1`, [threadId]);
    const response = await answer(id, { answer: "yes", cardSha256 });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: "changed" });
    expect(await store.find(id)).toMatchObject({
      status: "failed",
      errorCode: "thread_version_conflict",
    });
    expect(await thread(threadId)).toEqual({ attentionState: "needs_attention", version: "5" });
    expect(await audits(threadId)).toBe(0);
  });

  it("closes the question when AI is switched off for the account, and takes a No", async () => {
    const threadId = await newThread();
    const id = await ask(threadId);
    const { cardSha256 } = await shown(id);
    aiOn = false;
    try {
      const response = await answer(id, { answer: "yes", cardSha256 });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "ai_switched_off",
        pendingAction: { state: "stopped" },
      });
    } finally {
      aiOn = true;
    }
    expect(await store.find(id)).toMatchObject({
      status: "closed",
      closeReason: "ai_switched_off",
    });

    const other = await ask(await newThread());
    const no = await answer(other, { answer: "no" });
    expect(no.statusCode).toBe(200);
    expect(no.json()).toMatchObject({ state: "declined" });
    expect((await answer(other, { answer: "no" })).statusCode).toBe(409);
    expect(starts).not.toContain(id);
    expect(starts).not.toContain(other);
  });
});
