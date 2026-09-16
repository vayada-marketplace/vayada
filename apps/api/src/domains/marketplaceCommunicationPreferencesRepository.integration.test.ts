import {
  parseReplaceMarketplaceCommunicationPreferences,
  type MarketplaceCommunicationLaunchPolicy,
  type ReplaceMarketplaceCommunicationPreferencesCommand,
} from "@vayada/domain-marketplace";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgMarketplaceCommunicationPreferencesRepository } from "./marketplaceCommunicationPreferencesRepository.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const userId = "a2022000-0000-4000-8000-000000000001";
const otherUserId = "a2022000-0000-4000-8000-000000000002";
const organizationId = "a2022000-0000-4000-8000-000000000003";
const otherOrganizationId = "a2022000-0000-4000-8000-000000000004";
const acceptedAt = "2026-09-17T01:00:00.000Z";
const updatedAt = "2026-09-17T02:00:00.000Z";
const policyEffectiveAt = "2026-09-01T00:00:00.000Z";
const operation = "marketplace.communication_preferences.replace";
const auditFailureFunction = "platform.vay2022_fail_communication_preference_audit";
const auditFailureTrigger = "trg_vay2022_fail_communication_preference_audit";

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL Marketplace communication preferences", () => {
  const admin = new pg.Client({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
  });
  let repositoryTime = acceptedAt;
  const repository = createPgMarketplaceCommunicationPreferencesRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://integration-test-disabled",
    max: 6,
    now: () => new Date(repositoryTime),
  });

  beforeAll(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    await admin.connect();
  });
  beforeEach(async () => {
    await cleanup();
    await seedIdentity();
    repositoryTime = acceptedAt;
  });
  afterAll(async () => {
    await repository.close();
    await cleanup();
    await admin.end();
  });

  it("resolves missing rows from the audited launch policy", async () => {
    await expect(
      repository.getCommunicationPreferences(scope("service_default_on")),
    ).resolves.toMatchObject({
      organizationId,
      revision: 0,
      email: { state: "on", source: "policy_default", effectiveAt: policyEffectiveAt },
      topics: {
        collaborationActionRequired: {
          cadence: "immediate",
          source: "policy_default",
          effectiveAt: policyEffectiveAt,
        },
      },
    });
    await expect(repository.getCommunicationPreferences(scope("disabled"))).resolves.toMatchObject({
      revision: 0,
      email: { state: "off" },
      topics: { collaborationActionRequired: { cadence: "off" } },
    });
  });

  it("atomically replaces the document and exactly replays success and conflicts", async () => {
    const first = command("create", 0, "off", "off");
    const created = await repository.replaceCommunicationPreferences(first);
    expect(created).toMatchObject({
      ok: true,
      preferences: {
        organizationId,
        revision: 1,
        email: { state: "off", source: "settings", effectiveAt: acceptedAt },
        topics: {
          collaborationActionRequired: {
            cadence: "off",
            source: "settings",
            effectiveAt: acceptedAt,
          },
        },
      },
    });
    await expect(repository.replaceCommunicationPreferences(first)).resolves.toEqual(created);
    await expect(
      repository.replaceCommunicationPreferences(command("create", 0, "on", "off")),
    ).resolves.toEqual({ ok: false, error: { code: "idempotency_conflict" } });

    const stale = command("stale", 0, "on", "immediate");
    const originalConflict = await repository.replaceCommunicationPreferences(stale);
    expect(originalConflict).toEqual({
      ok: false,
      error: { code: "preference_conflict", currentRevision: 1 },
    });
    repositoryTime = updatedAt;
    const updated = await repository.replaceCommunicationPreferences(
      command("update", 1, "off", "immediate"),
    );
    expect(updated).toMatchObject({
      ok: true,
      preferences: {
        revision: 2,
        email: { state: "off", effectiveAt: acceptedAt },
        topics: { collaborationActionRequired: { cadence: "immediate", effectiveAt: updatedAt } },
      },
    });
    const unchanged = await repository.replaceCommunicationPreferences(
      command("unchanged", 2, "off", "immediate"),
    );
    expect(unchanged).toEqual(updated);
    const valueRevisions = await admin.query<{
      channelRevision: number;
      topicRevision: number;
    }>(
      `SELECT channel.effective_revision AS "channelRevision",
              topic.effective_revision AS "topicRevision"
       FROM marketplace.communication_channel_preferences channel
       JOIN marketplace.communication_topic_preferences topic
         ON topic.user_id = channel.user_id
        AND topic.organization_id = channel.organization_id
       WHERE channel.user_id = $1::uuid AND channel.organization_id = $2::uuid`,
      [userId, organizationId],
    );
    expect(valueRevisions.rows[0]).toEqual({ channelRevision: 1, topicRevision: 2 });
    await expect(repository.replaceCommunicationPreferences(stale)).resolves.toEqual(
      originalConflict,
    );
    await expect(repository.getCommunicationPreferences(scope("disabled"))).resolves.toMatchObject({
      revision: 2,
      email: { state: "off", source: "settings", effectiveAt: acceptedAt },
      topics: { collaborationActionRequired: { cadence: "immediate", source: "settings" } },
    });
    await expect(sideEffectCounts()).resolves.toEqual({
      aggregate: 1,
      audit: 4,
      channel: 1,
      idempotency: 4,
      topic: 1,
    });
  });

  it("keeps user and organization aggregates isolated", async () => {
    await repository.replaceCommunicationPreferences(command("primary", 0, "off", "off"));
    await repository.replaceCommunicationPreferences(
      command("other-user", 0, "on", "immediate", {
        targetUserId: otherUserId,
        actorUserId: otherUserId,
      }),
    );
    await repository.replaceCommunicationPreferences(
      command("other-organization", 0, "on", "off", {
        targetOrganizationId: otherOrganizationId,
      }),
    );

    await expect(repository.getCommunicationPreferences(scope("disabled"))).resolves.toMatchObject({
      revision: 1,
      email: { state: "off" },
    });
    await expect(
      repository.getCommunicationPreferences(scope("disabled", otherUserId)),
    ).resolves.toMatchObject({ revision: 1, email: { state: "on" } });
    await expect(
      repository.getCommunicationPreferences(scope("disabled", userId, otherOrganizationId)),
    ).resolves.toMatchObject({
      revision: 1,
      topics: { collaborationActionRequired: { cadence: "off" } },
    });
    await expect(
      repository.getCommunicationPreferences(scope("disabled", otherUserId, otherOrganizationId)),
    ).resolves.toMatchObject({ revision: 0, email: { source: "policy_default" } });
    await expect(
      repository.replaceCommunicationPreferences(
        command("cross-user", 1, "on", "immediate", { actorUserId: otherUserId }),
      ),
    ).resolves.toEqual({ ok: false, error: { code: "scope_forbidden" } });
  });

  it("serializes concurrent first writes and rolls back when audit fails", async () => {
    const concurrent = await Promise.all([
      repository.replaceCommunicationPreferences(command("concurrent-a", 0, "on", "immediate")),
      repository.replaceCommunicationPreferences(command("concurrent-b", 0, "off", "off")),
    ]);
    expect(concurrent.filter((result) => result.ok)).toHaveLength(1);
    expect(concurrent.filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: "preference_conflict", currentRevision: 1 } },
    ]);

    await cleanupPreferences();
    await installAuditFailureTrigger();
    try {
      await expect(
        repository.replaceCommunicationPreferences(command("audit-failure", 0, "off", "off")),
      ).rejects.toThrow("injected VAY-2022 audit failure");
      await expect(sideEffectCounts()).resolves.toEqual({
        aggregate: 0,
        audit: 0,
        channel: 0,
        idempotency: 0,
        topic: 0,
      });
    } finally {
      await removeAuditFailureTrigger();
    }
  });

  function scope(
    launchPolicy: MarketplaceCommunicationLaunchPolicy,
    targetUserId = userId,
    targetOrganizationId = organizationId,
  ) {
    return {
      userId: targetUserId,
      organizationId: targetOrganizationId,
      policy: { launchPolicy, effectiveAt: policyEffectiveAt },
    };
  }

  function command(
    idempotencyKey: string,
    expectedRevision: number,
    state: "on" | "off",
    cadence: "immediate" | "off",
    overrides: {
      targetUserId?: string;
      actorUserId?: string;
      targetOrganizationId?: string;
    } = {},
  ): ReplaceMarketplaceCommunicationPreferencesCommand {
    const request = parseReplaceMarketplaceCommunicationPreferences({
      contractVersion: "marketplace-communications.v1",
      expectedRevision,
      email: { state },
      topics: { collaborationActionRequired: { cadence } },
    });
    if (!request) throw new Error("Invalid VAY-2022 command fixture");
    const targetUserId = overrides.targetUserId ?? userId;
    return {
      organizationId: overrides.targetOrganizationId ?? organizationId,
      userId: targetUserId,
      idempotencyKey,
      audit: {
        actorUserId: overrides.actorUserId ?? targetUserId,
        requestId: `request-${idempotencyKey}`,
        correlationId: "correlation-vay-2022",
        requestedAt: acceptedAt,
      },
      request,
    };
  }

  async function seedIdentity(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status) VALUES
       ($1::uuid, 'vay2022@example.test', 'VAY-2022', 'active'),
       ($2::uuid, 'vay2022-other@example.test', 'VAY-2022 Other', 'active')`,
      [userId, otherUserId],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status) VALUES
       ($1::uuid, 'creator_workspace', 'VAY-2022', 'vay-2022', 'active'),
       ($2::uuid, 'creator_workspace', 'VAY-2022 Other', 'vay-2022-other', 'active')`,
      [organizationId, otherOrganizationId],
    );
  }

  async function sideEffectCounts() {
    const result = await admin.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM marketplace.communication_preference_sets
           WHERE organization_id = $1::uuid)::text AS aggregate,
         (SELECT count(*) FROM marketplace.communication_channel_preferences
           WHERE organization_id = $1::uuid)::text AS channel,
         (SELECT count(*) FROM marketplace.communication_topic_preferences
           WHERE organization_id = $1::uuid)::text AS topic,
         (SELECT count(*) FROM platform.product_audit_events
           WHERE organization_id = $1::uuid
             AND action LIKE 'marketplace.communication_preferences.%')::text AS audit,
         (SELECT count(*) FROM platform.idempotency_keys
           WHERE organization_id = $1::uuid AND operation = $2)::text AS idempotency`,
      [organizationId, operation],
    );
    return Object.fromEntries(
      Object.entries(result.rows[0]!).map(([key, value]) => [key, Number(value)]),
    );
  }

  async function installAuditFailureTrigger(): Promise<void> {
    await removeAuditFailureTrigger();
    await admin.query(
      `CREATE FUNCTION ${auditFailureFunction}()
       RETURNS trigger LANGUAGE plpgsql AS $function$
       BEGIN
         IF NEW.organization_id = '${organizationId}'::uuid
            AND NEW.action = 'marketplace.communication_preferences.updated' THEN
           RAISE EXCEPTION 'injected VAY-2022 audit failure';
         END IF;
         RETURN NEW;
       END;
       $function$`,
    );
    await admin.query(
      `CREATE TRIGGER ${auditFailureTrigger}
       BEFORE INSERT ON platform.product_audit_events
       FOR EACH ROW EXECUTE FUNCTION ${auditFailureFunction}()`,
    );
  }

  async function removeAuditFailureTrigger(): Promise<void> {
    await admin.query(
      `DROP TRIGGER IF EXISTS ${auditFailureTrigger} ON platform.product_audit_events`,
    );
    await admin.query(`DROP FUNCTION IF EXISTS ${auditFailureFunction}()`);
  }

  async function cleanupPreferences(): Promise<void> {
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      for (const statement of [
        "DELETE FROM platform.product_audit_events WHERE organization_id = ANY($1::uuid[])",
        "DELETE FROM platform.idempotency_keys WHERE organization_id = ANY($1::uuid[])",
        "DELETE FROM marketplace.communication_topic_preferences WHERE organization_id = ANY($1::uuid[])",
        "DELETE FROM marketplace.communication_channel_preferences WHERE organization_id = ANY($1::uuid[])",
        "DELETE FROM marketplace.communication_preference_sets WHERE organization_id = ANY($1::uuid[])",
      ]) {
        await admin.query(statement, [[organizationId, otherOrganizationId]]);
      }
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function cleanup(): Promise<void> {
    await removeAuditFailureTrigger();
    await cleanupPreferences();
    await admin.query("DELETE FROM identity.organizations WHERE id = ANY($1::uuid[])", [
      [organizationId, otherOrganizationId],
    ]);
    await admin.query("DELETE FROM identity.users WHERE id = ANY($1::uuid[])", [
      [userId, otherUserId],
    ]);
  }
});

function assertSafeTestDatabase(connectionString: string): void {
  const database = new URL(connectionString).pathname.slice(1).toLowerCase();
  if (!/(^|[_-])test([_-]|$)/i.test(database)) {
    throw new Error("Refusing to run communication preference integration outside a test database");
  }
}

describe("Communication preference integration database guard", () => {
  it("accepts test databases and rejects production-like names", () => {
    expect(() => assertSafeTestDatabase("postgresql://localhost/vayada_test")).not.toThrow();
    expect(() => assertSafeTestDatabase("postgresql://localhost/production")).toThrow(
      "Refusing to run communication preference integration outside a test database",
    );
  });
});
