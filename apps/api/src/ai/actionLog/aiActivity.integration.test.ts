import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type AiActionEntry, insertAiToolCall } from "./actionLog.js";
import { createPgAiActionLogRetentionStore, createPgAiActivityStore } from "./aiActivity.js";

const URL = process.env["TEST_DATABASE_URL"];
// Rows are seeded in replica mode (no foreign-key checks), so these need no identity fixtures.
const ORG = "25080000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "25080000-0000-4000-8000-0000000000a2";
const USER = "25080000-0000-4000-8000-0000000000b1";
const OTHER_USER = "25080000-0000-4000-8000-0000000000b2";
const PROPERTY = "25080000-0000-4000-8000-0000000000c1";
const NOW = new Date("2028-12-01T00:00:00.000Z");

describe.skipIf(!URL)("PostgreSQL AI action log: activity list and retention", () => {
  const admin = new pg.Client({ connectionString: URL });
  const activity = createPgAiActivityStore({ connectionString: URL ?? "postgresql://disabled" });
  const retention = createPgAiActionLogRetentionStore({
    connectionString: URL ?? "postgresql://disabled",
  });

  const seed = async (sql: (client: pg.Client) => Promise<unknown>) => {
    await admin.query("BEGIN");
    await admin.query("SET LOCAL session_replication_role = replica");
    await sql(admin);
    await admin.query("COMMIT");
  };
  const entry = (overrides: Partial<AiActionEntry>): AiActionEntry => ({
    organizationId: ORG,
    propertyId: PROPERTY,
    userId: USER,
    surface: "mcp",
    client: "https://chatgpt.com/oauth/client.json",
    action: "bookings_search",
    group: "R1",
    outcome: "ok",
    latencyMs: 3,
    requestId: randomUUID(),
    ...overrides,
  });
  const cleanup = () =>
    seed(async (client) => {
      await client.query(
        "DELETE FROM platform.ai_tool_calls WHERE organization_id = ANY($1::uuid[])",
        [[ORG, OTHER_ORG]],
      );
      await client.query(
        "DELETE FROM pms.message_assistance_results WHERE property_id = $1::uuid",
        [PROPERTY],
      );
    });

  beforeAll(async () => {
    await admin.connect();
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await Promise.all([admin.end(), activity.close(), retention.close()]);
  });

  it("lists one account newest first, per user, and pages through equal timestamps", async () => {
    const at = new Date("2028-11-30T10:00:00.000Z");
    await seed(async (client) => {
      for (let n = 0; n < 3; n += 1) await insertAiToolCall(client, entry({ occurredAt: at }));
      await insertAiToolCall(
        client,
        entry({ userId: OTHER_USER, occurredAt: new Date(at.getTime() + 1) }),
      );
      await insertAiToolCall(client, entry({ organizationId: OTHER_ORG }));
    });

    const all = await activity.list({ organizationId: ORG, limit: 10 });
    expect(all).toHaveLength(4);
    expect(all[0]!.userId).toBe(OTHER_USER);
    expect(all[0]).toMatchObject({
      surface: "mcp",
      group: "R1",
      recordsRead: [],
      operationId: null,
    });

    const mine = await activity.list({ organizationId: ORG, userId: USER, limit: 10 });
    expect(mine.map((row) => row.userId)).toEqual([USER, USER, USER]);

    const seen: string[] = [];
    let before: { occurredAt: string; id: string } | undefined;
    for (;;) {
      const page = await activity.list({ organizationId: ORG, userId: USER, before, limit: 2 });
      seen.push(...page.map((row) => row.id));
      if (page.length < 2) break;
      before = { occurredAt: page[1]!.occurredAt, id: page[1]!.id };
    }
    expect(seen).toEqual(mine.map((row) => row.id));
  });

  it("deletes log rows after two years and empties expired Inbox assist results", async () => {
    const twoYears = new Date("2026-12-01T00:00:00.000Z");
    await seed(async (client) => {
      await insertAiToolCall(client, entry({ occurredAt: new Date(twoYears.getTime() - 60_000) }));
      await insertAiToolCall(client, entry({ occurredAt: new Date(twoYears.getTime() + 60_000) }));
      for (const [retainUntil, text] of [
        ["2028-11-30T00:00:00.000Z", "expired draft"],
        ["2028-12-02T00:00:00.000Z", "current draft"],
      ])
        await client.query(
          `INSERT INTO pms.message_assistance_results
             (property_id, thread_id, idempotency_key_id, kind, assisted_text, created_at,
              pii_retention_until)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'translate_draft', $4, $5::timestamptz - interval '30 days',
                   $5::timestamptz)`,
          [PROPERTY, randomUUID(), randomUUID(), text, retainUntil],
        );
    });

    // The database is shared with other suites in CI: count only this suite's rows.
    const first = await retention.purgeExpiredBatch(NOW, 1_000);
    expect(first.logRows).toBeGreaterThanOrEqual(1);
    expect(first.assistResults).toBeGreaterThanOrEqual(1);
    expect(await retention.purgeExpiredBatch(NOW, 1_000)).toEqual({ logRows: 0, assistResults: 0 });
    const left = await activity.list({ organizationId: ORG, limit: 10 });
    expect(left.map((row) => row.occurredAt.slice(0, 10))).toEqual(["2026-12-01"]);
    const results = await admin.query(
      `SELECT assisted_text, purged_at IS NOT NULL AS purged
         FROM pms.message_assistance_results WHERE property_id = $1::uuid ORDER BY pii_retention_until`,
      [PROPERTY],
    );
    expect(results.rows).toEqual([
      { assisted_text: null, purged: true },
      { assisted_text: "current draft", purged: false },
    ]);
  });
});
