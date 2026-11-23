// The one executor of AI changes on real PostgreSQL (VAY-2524): real identity, roles, entitlements
// and property scope, the real inbox route with its real command, and the real operation store. An
// answered change runs exactly once, with the same key, through a double click, a second tab, a
// resumed run, a run that broke before it knew the outcome and a worker that died after sending.
import { createHash, randomUUID } from "node:crypto";

import {
  createFakeVerifier,
  createPgIdentityRepository,
  injectAsDelegate,
  resolveDelegatedChangeContext,
  type IdentityRepository,
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
import type { PmsInboxTriagePort } from "../../domains/pmsInbox.js";
import { createPgPmsInboxTriagePort } from "../../domains/pmsInboxTriageCommand.js";
import { memoryAiActionLog } from "../actionLog/memoryActionLog.fixtures.js";
import { ACTION_FIXTURES } from "../actions/actionFixtures.fixtures.js";
import { changeRequest } from "../actions/defineChangeAction.js";
import { threadMarkDone } from "../actions/threadTriage.js";
import { createAiChangeExecutor } from "./executor.js";
import { createPgAiOperationStore } from "./operationStore.js";

const url = process.env["TEST_DATABASE_URL"];
const PREFIX = `vay2524-${randomUUID().slice(0, 8)}`;
const org = randomUUID();
const property = randomUUID();
// A second property of the account: a change for the first must not reach it.
const otherProperty = randomUUID();
const user = randomUUID();
const conversation = randomUUID();
const DISABLED = "postgresql://integration-test-disabled";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)("the executor of AI changes on PostgreSQL (VAY-2524)", () => {
  const admin = new pg.Client({ connectionString: url });
  const store = createPgAiOperationStore({ connectionString: url ?? DISABLED, max: 4 });
  const triage = createPgPmsInboxTriagePort({ connectionString: url ?? DISABLED, max: 4 });
  // The real command, which the test can make break once (a lost database connection), and which
  // shows the AI's limits each command was given.
  let breakNext = false;
  // ...or answer slowly (a request that outlives part of its lease).
  let delayNextMs = 0;
  const narrowings: unknown[] = [];
  const port: PmsInboxTriagePort = {
    async transition(input) {
      narrowings.push(input.narrowing);
      if (delayNextMs) {
        const ms = delayNextMs;
        delayNextMs = 0;
        await pause(ms);
      }
      if (breakNext) {
        breakNext = false;
        throw new Error("connection lost");
      }
      return triage.transition(input);
    },
  };
  const log = memoryAiActionLog();
  const runFailures: unknown[] = [];
  let app: ReturnType<typeof buildApp>;
  let identity: IdentityRepository;
  let authorizationResolver: ReturnType<typeof createAuthorizationResolver>;
  const executor = (holder: string, leaseMs = 60_000) =>
    createAiChangeExecutor({
      app,
      store,
      identity,
      authorizationResolver,
      log,
      holder,
      leaseMs,
      onLogFailure: (error) => runFailures.push(error),
      onRunFailure: (error) => runFailures.push(error),
    });

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
    for (const [id, label] of [
      [property, PREFIX],
      [otherProperty, `${PREFIX}-other`],
    ] as const) {
      await admin.query(
        `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
         VALUES ($1::uuid, $2, $2)`,
        [id, label],
      );
      await admin.query(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship)
         VALUES ($1::uuid, 'hotel_catalog', 'property', $2::text, 'owner'),
                ($1::uuid, 'pms', 'pms_property', $2::text, 'owner')`,
        [org, id],
      );
    }
    await admin.query(`INSERT INTO identity.users (id, email) VALUES ($1, $2)`, [
      user,
      `${PREFIX}@example.test`,
    ]);
    // The identity lookup finds a user through their sign-in identity.
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
      verifier: createFakeVerifier(new Map()),
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
    // No `delegation` option: the app's own gate (the registry of AI actions) is what runs.
    app = buildApp({
      logger: false,
      ...ACTION_FIXTURES.find((fixture) => fixture.action === "rooms_list@1")!.appOptions(),
      pmsInboxTriagePort: port,
      auth,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await store.end();
    await triage.close();
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
    await admin.query(`DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])`, [
      [property, otherProperty],
    ]);
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

  /** How often the command really ran for this thread: its audit rows. */
  const audits = async (threadId: string) =>
    (
      await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM platform.product_audit_events
          WHERE target_resource_type = 'message_thread' AND target_resource_id = $1`,
        [threadId],
      )
    ).rows[0]!.n;

  const ask = (threadId: string, requestScope = "turn-1", channel: "in_app" | "mcp" = "in_app") =>
    store.propose(
      {
        organizationId: org,
        propertyId: property,
        userId: user,
        ...(channel === "mcp"
          ? { surface: "mcp" as const, connectionId: conversation, client: "claude.ai" }
          : {
              surface: "in_app" as const,
              conversationId: conversation,
              requestScope,
              client: "vayada:pms",
            }),
        action: threadMarkDone,
        arguments: { propertyId: property, threadId, expectedThreadVersion: 4 },
      },
      new Date(),
    );

  /** Lets an operation's lease run out now, as if its worker stopped. */
  const expireLease = (operationId: string) =>
    admin.query(
      `UPDATE platform.ai_operations SET lease_expires_at = now() - interval '1 second'
        WHERE id = $1 AND status = 'running'`,
      [operationId],
    );

  /** The key the route saw for an operation's one step. */
  const routeKey = (operationId: string) => `op_${operationId}:1:thread_mark_done`;

  it("runs an answered change once: a double click and a second tab join the run", async () => {
    const threadId = await newThread();
    const { operation } = await ask(threadId);
    const [first, second] = await Promise.all([
      executor("tab-a").startAndRun(operation.id),
      executor("tab-b").startAndRun(operation.id),
    ]);
    expect([first?.status, second?.status]).toContain("done");
    expect(await store.find(operation.id)).toMatchObject({
      status: "done",
      attempts: 1,
      stepCursor: 1,
      result: { threadId, attentionState: "done", threadVersion: 5 },
    });
    expect(await thread(threadId)).toEqual({ attentionState: "done", version: "5" });
    expect(await audits(threadId)).toBe(1);
    // The route's own key row is the operation's key: the AI log joins the route's records.
    const keys = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM platform.idempotency_keys
        WHERE property_id = $1 AND key_hash = $2`,
      [property, sha256(routeKey(operation.id))],
    );
    expect(keys.rows[0]!.n).toBe(1);
    const logged = log.rows.filter((row) => row.operationId === operation.id);
    expect(logged).toEqual([
      expect.objectContaining({
        outcome: "ok",
        action: "thread_mark_done",
        group: "ask",
        correlationId: `op_${operation.id}`,
        idempotencyKeyHash: sha256(routeKey(operation.id)),
        propertyId: property,
        userId: user,
        recordsChanged: [{ type: "message_thread", id: threadId }],
      }),
    ]);
    // What the route itself wrote down: the operation as correlation, the logged request as cause.
    const audit = await admin.query<{ correlation: string; causation: string }>(
      `SELECT correlation_id AS correlation, causation_id AS causation
         FROM platform.product_audit_events
        WHERE target_resource_type = 'message_thread' AND target_resource_id = $1`,
      [threadId],
    );
    expect(audit.rows).toEqual([
      { correlation: `op_${operation.id}`, causation: logged[0]!.requestId },
    ]);
    // The command was held to the operation's property only, though the user has two.
    expect(narrowings.at(-1)).toEqual({ access: "change", propertyIds: [property] });
    expect(runFailures).toEqual([]);
  });

  it("runs an MCP change on its connection", async () => {
    const threadId = await newThread();
    const { operation } = await ask(threadId, "turn-1", "mcp");
    expect(await executor("tab-a").startAndRun(operation.id)).toMatchObject({ status: "done" });
    expect(log.rows.filter((row) => row.operationId === operation.id)).toEqual([
      expect.objectContaining({
        surface: "mcp",
        client: "claude.ai",
        connectionId: conversation,
        conversationId: null,
        outcome: "ok",
      }),
    ]);
  });

  it("never fails a taken-over run on a refusal once its earlier request may have gone out", async () => {
    const threadId = await newThread();
    const { operation } = await ask(threadId);
    const started = await store.start(
      operation.id,
      { holder: "dead-worker", ms: 60_000 },
      new Date(),
    );
    // The dead worker had recorded its request as sent: whether it went out nobody knows.
    await store.recordStep(operation.id, started!.operation.leaseOwner!, {
      step: 1,
      requestId: randomUUID(),
      idempotencyKeySha256: sha256(routeKey(operation.id)),
      statusCode: 0,
      at: new Date().toISOString(),
    });
    // Meanwhile a person changes the conversation: the take-over's refusal says nothing about it.
    await admin.query(`UPDATE pms.message_threads SET version = 9 WHERE id = $1`, [threadId]);
    await expireLease(operation.id);
    await executor("recovery").recover(50);
    expect(await store.find(operation.id)).toMatchObject({
      status: "running",
      attempts: 2,
      errorCode: null,
    });
  });

  it("fails a taken-over run on a refusal when its worker died before sending anything", async () => {
    const threadId = await newThread();
    const { operation } = await ask(threadId);
    await store.start(operation.id, { holder: "dead-worker", ms: 60_000 }, new Date());
    await admin.query(`UPDATE pms.message_threads SET version = 9 WHERE id = $1`, [threadId]);
    await expireLease(operation.id);
    await executor("recovery").recover(50);
    expect(await store.find(operation.id)).toMatchObject({
      status: "failed",
      attempts: 2,
      errorCode: "thread_version_conflict",
    });
  });

  it("takes over several runs, one after the other", async () => {
    const threads = [await newThread(), await newThread()];
    const ids: string[] = [];
    for (const threadId of threads) {
      const { operation } = await ask(threadId);
      await store.start(operation.id, { holder: "dead-worker", ms: 60_000 }, new Date());
      await expireLease(operation.id);
      ids.push(operation.id);
    }
    // Each take-over takes one run and runs it before it takes the next.
    const events: string[] = [];
    const watched = {
      ...store,
      takeOverExpired: (...args: Parameters<typeof store.takeOverExpired>) => {
        events.push(`take ${args[2]}`);
        return store.takeOverExpired(...args);
      },
      recordStep: (...args: Parameters<typeof store.recordStep>) => {
        events.push("step");
        return store.recordStep(...args);
      },
    };
    const recovery = createAiChangeExecutor({
      app,
      store: watched,
      identity,
      authorizationResolver,
      log,
      holder: "recovery",
      onLogFailure: (error) => runFailures.push(error),
      onRunFailure: (error) => runFailures.push(error),
    });
    expect(await recovery.recover(50)).toBeGreaterThanOrEqual(2);
    expect(events.filter((event) => event.startsWith("take"))).not.toContain("take 50");
    expect(events.slice(0, 4)).toEqual(["take 1", "step", "step", "take 1"]);
    for (const id of ids) expect((await store.find(id))?.status).toBe("done");
    for (const threadId of threads) {
      expect(await thread(threadId)).toEqual({ attentionState: "done", version: "5" });
    }
  });

  it("keeps its lease while a slow request runs, and stops waiting before the lease runs out", async () => {
    // Slow but in time: the lease is renewed while it runs, and the change is done.
    const slowThread = await newThread();
    const slow = await ask(slowThread);
    let renewals = 0;
    const counting = {
      ...store,
      renewLease: (...args: Parameters<typeof store.renewLease>) => {
        renewals++;
        return store.renewLease(...args);
      },
    };
    const patient = createAiChangeExecutor({
      app,
      store: counting,
      identity,
      authorizationResolver,
      log,
      holder: "slow",
      leaseMs: 1_500,
      onLogFailure: (error) => runFailures.push(error),
      onRunFailure: (error) => runFailures.push(error),
    });
    delayNextMs = 700;
    expect(await patient.startAndRun(slow.operation.id)).toMatchObject({ status: "done" });
    // Once right before sending, then every 500 ms while the request ran.
    expect(renewals).toBeGreaterThanOrEqual(2);

    // Too slow: the run stops waiting and stays running; the recovery job finishes it.
    const lateThread = await newThread();
    const late = await ask(lateThread);
    delayNextMs = 1_200;
    expect(await executor("hasty", 900).startAndRun(late.operation.id)).toMatchObject({
      status: "running",
    });
    expect(log.rows.filter((row) => row.operationId === late.operation.id)).toEqual([
      expect.objectContaining({ outcome: "failed", errorCode: "timeout" }),
    ]);
    await pause(800);
    await expireLease(late.operation.id);
    await executor("recovery").recover(50);
    expect(await store.find(late.operation.id)).toMatchObject({ status: "done", attempts: 2 });
    expect(await thread(lateThread)).toEqual({ attentionState: "done", version: "5" });
  });

  it("gives a resumed run (the AI SDK, a Mastra workflow) the stored outcome, never a second run", async () => {
    const threadId = await newThread();
    const { operation } = await ask(threadId);
    await executor("tab-a").startAndRun(operation.id);
    const before = log.rows.length;
    expect(await ask(threadId)).toMatchObject({
      created: false,
      operation: { id: operation.id, status: "done" },
    });
    expect(await executor("tab-c").startAndRun(operation.id)).toMatchObject({
      id: operation.id,
      status: "done",
    });
    expect(log.rows.length).toBe(before);
    expect(await thread(threadId)).toEqual({ attentionState: "done", version: "5" });
  });

  it("takes over a worker that died after sending and runs the change once, with the same key", async () => {
    const threadId = await newThread();
    const { operation } = await ask(threadId);
    // The dead worker started the change and sent its request, then died before writing it down.
    const started = await store.start(operation.id, { holder: "dead-worker", ms: 1 }, new Date());
    expect(started?.won).toBe(true);
    const context = await resolveDelegatedChangeContext(
      identity,
      {
        userId: user,
        organizationId: org,
        delegation: {
          channel: "in_app",
          conversationId: conversation,
          toolCallId: `op_${operation.id}`,
        },
        propertyIds: [property],
      },
      { authorizationResolver },
    );
    const built = changeRequest(threadMarkDone, operation.arguments, `op_${operation.id}:1`);
    if (!built.ok) throw new Error(built.message);
    expect((await injectAsDelegate(app, { context, ...built.request })).statusCode).toBe(200);
    await pause(10);

    expect(await executor("recovery").recover(50)).toBeGreaterThanOrEqual(1);
    expect(await store.find(operation.id)).toMatchObject({
      status: "done",
      attempts: 2,
      result: { threadId, threadVersion: 5 },
    });
    // Changed once: the replay got the route's stored answer.
    expect(await thread(threadId)).toEqual({ attentionState: "done", version: "5" });
    expect(await audits(threadId)).toBe(1);
  });

  it("leaves a run that broke before it knew the outcome to the recovery job", async () => {
    const threadId = await newThread();
    const { operation } = await ask(threadId);
    breakNext = true;
    expect(await executor("tab-a").startAndRun(operation.id)).toMatchObject({
      status: "running",
    });
    expect(await thread(threadId)).toEqual({ attentionState: "needs_attention", version: "4" });
    await expireLease(operation.id);
    expect(await executor("recovery").recover(50)).toBeGreaterThanOrEqual(1);
    expect(await store.find(operation.id)).toMatchObject({ status: "done", attempts: 2 });
    expect(await thread(threadId)).toEqual({ attentionState: "done", version: "5" });
    expect(
      log.rows
        .filter((row) => row.operationId === operation.id)
        .map((row) => [row.outcome, row.errorCode]),
    ).toEqual([
      ["failed", "read_model_unavailable"],
      ["ok", null],
    ]);
  });

  it("refuses a change a person made meanwhile: the conversation changed, nothing is applied", async () => {
    const threadId = await newThread();
    const { operation } = await ask(threadId);
    // A person reopens it from the inbox before the Yes.
    await triage.transition({
      propertyId: property,
      threadId,
      organizationId: org,
      actorUserId: user,
      actorMembershipId: (
        await admin.query<{ id: string }>(
          `SELECT id::text FROM identity.organization_memberships WHERE user_id = $1`,
          [user],
        )
      ).rows[0]!.id,
      action: "follow_up",
      idempotencyKey: `${PREFIX}-person-${threadId}`,
      expectedThreadVersion: 4,
      followUpAt: new Date(Date.now() + 86_400_000).toISOString(),
      audit: {
        requestId: randomUUID(),
        correlationId: randomUUID(),
        requestedAt: new Date().toISOString(),
      },
      narrowing: null,
    });
    expect(await executor("tab-a").startAndRun(operation.id)).toMatchObject({
      status: "failed",
      errorCode: "thread_version_conflict",
    });
    expect(await thread(threadId)).toEqual({ attentionState: "follow_up", version: "5" });
  });

  it("fails without a request when the action is gone or the arguments no longer fit", async () => {
    const threadId = await newThread();
    const before = log.rows.length;
    const gone = await store.propose(
      {
        organizationId: org,
        propertyId: property,
        userId: user,
        surface: "in_app",
        conversationId: conversation,
        client: "vayada:pms",
        action: { name: "thread_archive", version: 1, group: "ask" },
        arguments: { propertyId: property, threadId },
      },
      new Date(),
    );
    expect(await executor("tab-a").startAndRun(gone.operation.id)).toMatchObject({
      status: "failed",
      errorCode: "unknown_action",
      steps: [],
    });
    const unfit = await store.propose(
      {
        organizationId: org,
        propertyId: property,
        userId: user,
        surface: "in_app",
        conversationId: conversation,
        client: "vayada:pms",
        action: threadMarkDone,
        arguments: { propertyId: property, threadId, expectedThreadVersion: "four" },
      },
      new Date(),
    );
    expect(await executor("tab-a").startAndRun(unfit.operation.id)).toMatchObject({
      status: "failed",
      errorCode: "invalid_input",
      steps: [],
    });
    expect(log.rows.length).toBe(before);
    expect(await thread(threadId)).toEqual({ attentionState: "needs_attention", version: "4" });
  });

  it("runs with the user's rights at the Yes: a member who left can't change anything", async () => {
    const threadId = await newThread();
    const { operation } = await ask(threadId);
    await admin.query(
      `UPDATE identity.organization_memberships SET status = 'suspended' WHERE user_id = $1`,
      [user],
    );
    try {
      expect(await executor("tab-a").startAndRun(operation.id)).toMatchObject({
        status: "failed",
        errorCode: "not_allowed",
        steps: [],
      });
    } finally {
      await admin.query(
        `UPDATE identity.organization_memberships SET status = 'active' WHERE user_id = $1`,
        [user],
      );
    }
    expect(await thread(threadId)).toEqual({ attentionState: "needs_attention", version: "4" });
  });
});
