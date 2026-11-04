import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPgWorkosWebhookStore } from "./workosWebhooks.js";
import {
  applyWorkosUserResync,
  planWorkosUserResync,
  summarizeWorkosUserResyncPlan,
  WORKOS_USER_RESYNC_FAILURE_SUMMARY,
  WORKOS_USER_RESYNC_REASON_CODE,
  type WorkosUserReader,
  type WorkosUserResyncPlan,
} from "./workosUserResync.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];

type Fixture = {
  run: string;
  workosIds: Record<
    | "update"
    | "sync"
    | "missing"
    | "deleted"
    | "unlinked"
    | "smoke"
    | "unlinkedSmoke"
    | "erasedSmoke",
    string
  >;
  userIds: Record<"update" | "sync" | "missing" | "deleted" | "smoke" | "erasedSmoke", string>;
  emails: string[];
  names: string[];
  receiptIds: string[];
  deadLetters: Record<
    | "update"
    | "sync"
    | "missing"
    | "deleted"
    | "unlinked"
    | "smoke"
    | "unlinkedSmoke"
    | "erasedSmoke"
    | "otherSummary"
    | "resolved",
    string[]
  >;
  workosNow: Map<string, Record<string, unknown> | null>;
};

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL WorkOS user resync (VAY-2479)", () => {
  const connectionString = TEST_DATABASE_URL ?? "postgresql://integration-test-disabled";
  const admin = new pg.Client({ connectionString });
  const pool = new pg.Pool({ connectionString, max: 2 });
  const store = createPgWorkosWebhookStore({ connectionString, max: 2 });
  const fixtures: Fixture[] = [];

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await cleanUp(fixture);
  });

  afterAll(async () => {
    await Promise.all([store.close(), pool.end()]);
    await admin.end();
  });

  it("dry run reads only and reports each user by outcome, without names or emails", async () => {
    const fixture = await createFixture();
    const reader = fakeWorkos(fixture);
    const before = await snapshot(fixture);

    const plan = await planWorkosUserResync({ pool, workos: reader });

    expectOnlyOwnRows(plan, fixture);
    expect(await snapshot(fixture)).toEqual(before);
    expect(ownUsers(plan, fixture)).toEqual([
      { key: "deleted", outcome: "user_deleted", changes: [], deadLetters: 1 },
      { key: "missing", outcome: "missing_in_workos", changes: [], deadLetters: 1 },
      { key: "sync", outcome: "in_sync", changes: [], deadLetters: 1 },
      { key: "unlinked", outcome: "not_linked", changes: [], deadLetters: 1 },
      {
        key: "update",
        outcome: "update",
        changes: ["email", "name", "provider_email", "email_verified"],
        deadLetters: 2,
      },
    ]);
    // Smoke: our email ends in .test, or (unlinked, or an erased account) every webhook email does.
    expect(plan.smoke.deadLetterIds).toEqual(smokeDeadLetters(fixture).sort());
    expect(plan.smoke.users).toBe(3);
    expect(plan.smoke.usersNotDeleted).toBe(0);
    // Only the open guard dead letters are in the plan.
    const planned = new Set(
      plan.users.flatMap((user) => user.deadLetters.map((d) => d.deadLetterId)),
    );
    for (const id of [...fixture.deadLetters.otherSummary, ...fixture.deadLetters.resolved]) {
      expect(planned.has(id)).toBe(false);
    }
    // A deleted user is never looked up in WorkOS.
    expect(reader.calls).not.toContain(fixture.workosIds.deleted);
    expect(plan.planSha256).toMatch(/^[0-9a-f]{64}$/);

    const printed = JSON.stringify(summarizeWorkosUserResyncPlan(plan));
    for (const value of [...fixture.emails, ...fixture.names]) expect(printed).not.toContain(value);
    for (const workosId of Object.values(fixture.workosIds))
      expect(printed).not.toContain(workosId);
  });

  it("applies the webhook update to linked users only, resolves their dead letters, acknowledges smoke ones, and a second run changes nothing", async () => {
    const fixture = await createFixture();
    const reader = fakeWorkos(fixture);
    const plan = await planWorkosUserResync({ pool, workos: reader });
    expectOnlyOwnRows(plan, fixture);
    const before = await snapshot(fixture);
    const progress: unknown[] = [];

    const result = await applyWorkosUserResync({
      pool,
      workos: reader,
      planSha256: plan.planSha256,
      approvalRef: "VAY-2479",
      onProgress: (line) => progress.push(line),
    });

    expect(result).toEqual({
      usersUpdated: 1,
      usersResolvedWithoutChange: 1,
      usersDeleted: 1,
      usersSkipped: 2,
      deadLettersResolved: 4,
      deadLettersAcknowledged: 4,
    });
    // One progress line per committed user, by short reference only.
    expect(progress).toEqual([
      { ref: ref(fixture.workosIds.deleted), outcome: "user_deleted", deadLettersResolved: 1 },
      { ref: ref(fixture.workosIds.sync), outcome: "in_sync", deadLettersResolved: 1 },
      { ref: ref(fixture.workosIds.update), outcome: "update", deadLettersResolved: 2 },
    ]);
    const after = await snapshot(fixture);

    // The out-of-date user now matches WorkOS, through the webhook's own update.
    const updated = after.users[fixture.userIds.update]!;
    expect(updated).toMatchObject({
      email: `resync-${fixture.run}-new@example.com`,
      name: `Ana ${fixture.run} Updated`,
      status: "active",
      providerEmail: `resync-${fixture.run}-new@example.com`,
      providerEmailVerified: true,
    });
    expect(updated.rawProfile).toEqual(fixture.workosNow.get(fixture.workosIds.update));
    // Users that need no write are left exactly as they were.
    for (const key of ["sync", "missing", "deleted", "smoke", "erasedSmoke"] as const) {
      expect(after.users[fixture.userIds[key]]).toEqual(before.users[fixture.userIds[key]]);
    }
    // No user, link or membership was created; nothing exists for the unlinked WorkOS ID.
    expect(after.userCount).toBe(before.userCount);
    expect(after.linkCount).toBe(before.linkCount);
    expect(after.membershipCount).toBe(before.membershipCount);
    expect(after.unlinkedIdentityCount).toBe(0);

    const status = (ids: string[]) => ids.map((id) => after.deadLetters[id]!.recoveryStatus);
    for (const key of ["update", "sync", "deleted"] as const) {
      expect(status(fixture.deadLetters[key])).toEqual(
        fixture.deadLetters[key].map(() => "resolved"),
      );
      for (const id of fixture.deadLetters[key])
        expect(after.deadLetters[id]!.resolvedAt).toBe(true);
    }
    expect(status(smokeDeadLetters(fixture))).toEqual(
      smokeDeadLetters(fixture).map(() => "acknowledged"),
    );
    for (const id of smokeDeadLetters(fixture))
      expect(after.deadLetters[id]!.acknowledgedAt).toBe(true);
    for (const key of ["missing", "unlinked", "otherSummary"] as const) {
      expect(status(fixture.deadLetters[key])).toEqual(["open"]);
    }
    expect(status(fixture.deadLetters.resolved)).toEqual(["resolved"]);

    // One audit row per resolved receipt, shaped like the webhook's own.
    expect(after.audit).toEqual(
      expect.arrayContaining([
        ...fixture.deadLetters.update.map(() => ({
          eventType: "workos.webhook.normalized",
          userId: fixture.userIds.update,
          recovery: "workos_user_resync",
          approvalRef: "VAY-2479",
        })),
        {
          eventType: "workos.webhook.normalized",
          userId: fixture.userIds.sync,
          recovery: "workos_user_resync",
          approvalRef: "VAY-2479",
        },
        {
          eventType: "workos.webhook.ignored",
          userId: null,
          recovery: "workos_user_resync",
          approvalRef: "VAY-2479",
        },
      ]),
    );
    expect(after.audit.filter((row) => row.recovery === "workos_user_resync")).toHaveLength(4);

    // Second run: only the skipped users remain, and applying that plan writes nothing.
    const second = await planWorkosUserResync({ pool, workos: reader });
    expect(ownUsers(second, fixture).map((user) => user.key)).toEqual(["missing", "unlinked"]);
    expect(second.smoke.deadLetterIds).toEqual([]);
    await expect(
      applyWorkosUserResync({
        pool,
        workos: reader,
        planSha256: second.planSha256,
        approvalRef: "VAY-2479",
      }),
    ).resolves.toEqual({
      usersUpdated: 0,
      usersResolvedWithoutChange: 0,
      usersDeleted: 0,
      usersSkipped: 2,
      deadLettersResolved: 0,
      deadLettersAcknowledged: 0,
    });
    expect(await snapshot(fixture)).toEqual(after);
  });

  it("refuses a plan that no longer matches WorkOS or the database, and writes nothing", async () => {
    const fixture = await createFixture();
    const reader = fakeWorkos(fixture);
    const plan = await planWorkosUserResync({ pool, workos: reader });
    expectOnlyOwnRows(plan, fixture);
    const before = await snapshot(fixture);

    await expect(
      applyWorkosUserResync({
        pool,
        workos: reader,
        planSha256: "0".repeat(64),
        approvalRef: "VAY-2479",
      }),
    ).rejects.toMatchObject({ code: "plan_changed" });

    // WorkOS changed after the dry run.
    fixture.workosNow.set(fixture.workosIds.update, {
      ...(fixture.workosNow.get(fixture.workosIds.update) ?? {}),
      lastName: "Renamed",
    });
    await expect(
      applyWorkosUserResync({
        pool,
        workos: reader,
        planSha256: plan.planSha256,
        approvalRef: "VAY-2479",
      }),
    ).rejects.toMatchObject({ code: "plan_changed" });
    expect(await snapshot(fixture)).toEqual(before);
  });

  it("stops before writing a user whose record changed after the apply re-planned", async () => {
    const fixture = await createFixture();
    const reader = fakeWorkos(fixture);
    const plan = await planWorkosUserResync({ pool, workos: reader });
    expectOnlyOwnRows(plan, fixture);
    let applying = false;
    const racingReader: WorkosUserReader = {
      async getUser(workosUserId) {
        // The apply's own re-plan reads this user, then a profile edit lands before the write.
        if (applying && workosUserId === fixture.workosIds.update) {
          await admin.query("UPDATE identity.users SET name = $1 WHERE id = $2", [
            `Edited ${fixture.run}`,
            fixture.userIds.update,
          ]);
        }
        return reader.getUser(workosUserId);
      },
    };
    applying = true;

    await expect(
      applyWorkosUserResync({
        pool,
        workos: racingReader,
        planSha256: plan.planSha256,
        approvalRef: "VAY-2479",
      }),
    ).rejects.toMatchObject({
      code: "user_changed_since_plan",
      ref: ref(fixture.workosIds.update),
    });
    const after = await snapshot(fixture);
    expect(after.users[fixture.userIds.update]).toMatchObject({
      name: `Edited ${fixture.run}`,
      providerEmailVerified: false,
    });
    for (const id of fixture.deadLetters.update) {
      expect(after.deadLetters[id]!.recoveryStatus).toBe("open");
    }
  });

  // Apply acts on every open guard dead letter in the database, so stop before touching any row
  // another suite left behind.
  function expectOnlyOwnRows(plan: WorkosUserResyncPlan, fixture: Fixture): void {
    const ownUsers = new Set(Object.values(fixture.workosIds));
    const ownDeadLetters = new Set(Object.values(fixture.deadLetters).flat());
    expect(plan.users.map((user) => user.workosUserId).filter((id) => !ownUsers.has(id))).toEqual(
      [],
    );
    expect(plan.smoke.deadLetterIds.filter((id) => !ownDeadLetters.has(id))).toEqual([]);
  }

  function smokeDeadLetters(fixture: Fixture): string[] {
    return [
      ...fixture.deadLetters.smoke,
      ...fixture.deadLetters.unlinkedSmoke,
      ...fixture.deadLetters.erasedSmoke,
    ];
  }

  function fakeWorkos(fixture: Fixture): WorkosUserReader & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      async getUser(workosUserId) {
        calls.push(workosUserId);
        const user = fixture.workosNow.get(workosUserId);
        return user ? { ...user } : null;
      },
    };
  }

  function ownUsers(plan: WorkosUserResyncPlan, fixture: Fixture) {
    const keys = new Map(Object.entries(fixture.workosIds).map(([key, id]) => [id, key]));
    return plan.users
      .filter((user) => keys.has(user.workosUserId))
      .map((user) => ({
        key: keys.get(user.workosUserId)!,
        outcome: user.outcome,
        changes: user.changes,
        deadLetters: user.deadLetters.length,
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  async function createFixture(): Promise<Fixture> {
    const run = randomUUID().slice(0, 8);
    const workosId = (key: string) => `user_vay2479_${run}_${key}`;
    const workosIds = {
      update: workosId("update"),
      sync: workosId("sync"),
      missing: workosId("missing"),
      deleted: workosId("deleted"),
      unlinked: workosId("unlinked"),
      smoke: workosId("smoke"),
      unlinkedSmoke: workosId("unlinkedSmoke"),
      erasedSmoke: workosId("erasedSmoke"),
    };
    const fixture: Fixture = {
      run,
      workosIds,
      userIds: { update: "", sync: "", missing: "", deleted: "", smoke: "", erasedSmoke: "" },
      emails: [],
      names: [],
      receiptIds: [],
      deadLetters: {
        update: [],
        sync: [],
        missing: [],
        deleted: [],
        unlinked: [],
        smoke: [],
        unlinkedSmoke: [],
        erasedSmoke: [],
        otherSummary: [],
        resolved: [],
      },
      workosNow: new Map(),
    };
    fixtures.push(fixture);

    const linkedUsers = [
      ["update", `resync-${run}-old@example.com`, `Ana ${run}`, false],
      ["sync", `resync-${run}-sync@example.com`, `Ben ${run} Sync`, true],
      ["missing", `resync-${run}-missing@example.com`, `Cy ${run}`, false],
      ["deleted", `resync-${run}-deleted@example.com`, `Di ${run}`, false],
      ["smoke", `resync-${run}-smoke@example.test`, `Smoke ${run}`, false],
      // Privacy erasure rewrites the email, so only the webhook emails still say "smoke".
      ["erasedSmoke", `deleted+${run}@deleted.vayada.local`, `Erased ${run}`, false],
    ] as const;
    for (const [key, email, name, verified] of linkedUsers) {
      const userId = await store.upsertWorkosUser({
        workosUserId: workosIds[key],
        email,
        name,
        emailVerified: verified,
        status: "active",
        rawProfile: { id: workosIds[key] },
      });
      fixture.userIds[key] = userId!;
      fixture.emails.push(email);
      fixture.names.push(name);
    }
    await admin.query("UPDATE identity.users SET status = 'deleted' WHERE id = ANY($1::uuid[])", [
      [fixture.userIds.deleted, fixture.userIds.smoke, fixture.userIds.erasedSmoke],
    ]);

    fixture.workosNow.set(
      workosIds.update,
      workosUser(workosIds.update, `resync-${run}-new@example.com`, "Ana", `${run} Updated`, true),
    );
    fixture.workosNow.set(
      workosIds.sync,
      workosUser(workosIds.sync, `resync-${run}-sync@example.com`, "Ben", `${run} Sync`, true),
    );
    fixture.workosNow.set(workosIds.missing, null);
    fixture.emails.push(`resync-${run}-new@example.com`, `resync-${run}-unlinked@example.com`);
    fixture.names.push(`${run} Updated`);

    const guard = (key: keyof Fixture["deadLetters"], workosUserId: string, email: string) =>
      deadLetter(fixture, key, workosUserId, email, WORKOS_USER_RESYNC_FAILURE_SUMMARY);
    await guard("update", workosIds.update, `resync-${run}-old@example.com`);
    await guard("update", workosIds.update, `resync-${run}-new@example.com`);
    await guard("sync", workosIds.sync, `resync-${run}-sync@example.com`);
    await guard("missing", workosIds.missing, `resync-${run}-missing@example.com`);
    await guard("deleted", workosIds.deleted, `resync-${run}-deleted@example.com`);
    await guard("unlinked", workosIds.unlinked, `resync-${run}-unlinked@example.com`);
    await guard("smoke", workosIds.smoke, `resync-${run}-smoke@example.test`);
    await guard("smoke", workosIds.smoke, `resync-${run}-smoke@example.test`);
    await guard("unlinkedSmoke", workosIds.unlinkedSmoke, `resync-${run}-unlinked@example.test`);
    await guard("erasedSmoke", workosIds.erasedSmoke, `resync-${run}-erased@example.test`);
    // Another cause, and a guard dead letter that is already resolved: neither is touched.
    await deadLetter(
      fixture,
      "otherSummary",
      workosIds.sync,
      `resync-${run}-sync@example.com`,
      "WorkOS event is missing email",
    );
    await guard("resolved", workosIds.sync, `resync-${run}-sync@example.com`);
    await admin.query(
      `UPDATE platform.dead_letter_events SET recovery_status = 'resolved', resolved_at = now()
       WHERE id = ANY($1::uuid[])`,
      [fixture.deadLetters.resolved],
    );
    return fixture;
  }

  async function deadLetter(
    fixture: Fixture,
    key: keyof Fixture["deadLetters"],
    workosUserId: string,
    email: string,
    failureSummary: string,
  ): Promise<void> {
    const eventId = `evt_vay2479_${randomUUID()}`;
    const receipt = await store.insertReceipt({
      providerEventId: eventId,
      eventType: "user.updated",
      payloadHash: `sha256:${randomUUID()}`,
      signatureVerified: true,
      rawHeaders: {},
      rawPayload: { id: eventId, event: "user.updated", data: { id: workosUserId, email } },
      webhookKeyHash: `sha256:${randomUUID()}`,
    });
    await store.deadLetterReceipt({
      receiptId: receipt.receiptId,
      reasonCode: WORKOS_USER_RESYNC_REASON_CODE,
      failureSummary,
      failurePayload: { eventId, eventType: "user.updated" },
    });
    const row = await admin.query<{ id: string }>(
      "SELECT id::text AS id FROM platform.dead_letter_events WHERE webhook_event_id = $1",
      [receipt.receiptId],
    );
    fixture.receiptIds.push(receipt.receiptId);
    fixture.deadLetters[key].push(row.rows[0]!.id);
  }

  async function snapshot(fixture: Fixture) {
    const userIds = Object.values(fixture.userIds);
    const users = await admin.query(
      `SELECT users.id::text AS id, users.email, users.name, users.status,
              users.updated_at::text AS "updatedAt",
              external.provider_email AS "providerEmail",
              external.provider_email_verified AS "providerEmailVerified",
              external.raw_profile AS "rawProfile",
              external.updated_at::text AS "linkUpdatedAt"
       FROM identity.users AS users
       JOIN identity.external_identities AS external
         ON external.user_id = users.id AND external.provider = 'workos'
       WHERE users.id = ANY($1::uuid[])`,
      [userIds],
    );
    const deadLetters = await admin.query(
      `SELECT id::text AS id, recovery_status AS "recoveryStatus",
              resolved_at IS NOT NULL AS "resolvedAt", acknowledged_at IS NOT NULL AS "acknowledgedAt"
       FROM platform.dead_letter_events WHERE webhook_event_id = ANY($1::uuid[])`,
      [fixture.receiptIds],
    );
    const audit = await admin.query(
      `SELECT event_type AS "eventType", user_id::text AS "userId",
              payload ->> 'recovery' AS recovery, payload ->> 'approvalRef' AS "approvalRef"
       FROM identity.auth_reconciliation_events
       WHERE provider = 'workos' AND provider_event_id = ANY($1::text[])
         AND event_type <> 'workos.webhook.dead_lettered'
       ORDER BY event_type, user_id`,
      [fixture.receiptIds],
    );
    const counts = await admin.query<{
      userCount: number;
      linkCount: number;
      membershipCount: number;
      unlinkedIdentityCount: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM identity.users WHERE email = ANY($1::text[])) AS "userCount",
         (SELECT count(*)::int FROM identity.external_identities
          WHERE provider = 'workos' AND provider_user_id = ANY($2::text[])) AS "linkCount",
         (SELECT count(*)::int FROM identity.organization_memberships WHERE user_id = ANY($3::uuid[])) AS "membershipCount",
         (SELECT count(*)::int FROM identity.external_identities
          WHERE provider = 'workos' AND provider_user_id = $4) AS "unlinkedIdentityCount"`,
      [fixture.emails, Object.values(fixture.workosIds), userIds, fixture.workosIds.unlinked],
    );
    return {
      users: Object.fromEntries(users.rows.map((row) => [row.id, row])) as Record<
        string,
        Record<string, unknown>
      >,
      deadLetters: Object.fromEntries(deadLetters.rows.map((row) => [row.id, row])) as Record<
        string,
        { recoveryStatus: string; resolvedAt: boolean; acknowledgedAt: boolean }
      >,
      audit: audit.rows as {
        eventType: string;
        userId: string | null;
        recovery: string | null;
        approvalRef: string | null;
      }[],
      ...counts.rows[0]!,
    };
  }

  async function cleanUp(fixture: Fixture): Promise<void> {
    await admin.query(
      `DELETE FROM identity.auth_reconciliation_events
       WHERE provider = 'workos' AND (provider_event_id = ANY($1::text[]) OR provider_event_id = ANY($2::text[]))`,
      [fixture.receiptIds, Object.values(fixture.workosIds)],
    );
    await admin.query(
      "DELETE FROM platform.dead_letter_events WHERE webhook_event_id = ANY($1::uuid[])",
      [fixture.receiptIds],
    );
    await admin.query(
      "DELETE FROM platform.jobs WHERE queue_name = 'identity.webhooks' AND resource_id = ANY($1::text[])",
      [fixture.receiptIds],
    );
    // Receipts are append-only; without their dead letters they are outside every later plan.
    await admin.query(
      "DELETE FROM identity.external_identities WHERE provider = 'workos' AND provider_user_id = ANY($1::text[])",
      [Object.values(fixture.workosIds)],
    );
    await admin.query("DELETE FROM identity.users WHERE id = ANY($1::uuid[])", [
      Object.values(fixture.userIds).filter(Boolean),
    ]);
  }
});

function workosUser(
  id: string,
  email: string,
  firstName: string,
  lastName: string,
  emailVerified: boolean,
): Record<string, unknown> {
  // The shape @workos-inc/node's getUser returns.
  return {
    object: "user",
    id,
    email,
    emailVerified,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    profilePictureUrl: null,
    lastSignInAt: null,
    locale: null,
    externalId: null,
    metadata: {},
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
  };
}

// The plan's short reference: the last 8 characters of the WorkOS user ID.
function ref(workosUserId: string): string {
  return `…${workosUserId.slice(-8)}`;
}

function assertSafeTestDatabase(connectionString: string): void {
  const url = new URL(connectionString);
  if (
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
    !url.pathname.toLowerCase().includes("test")
  ) {
    throw new Error("Refusing to run WorkOS user resync integration tests on a non-test DB");
  }
}
