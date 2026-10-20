import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE = "vayada_marketplace_kept_payload_blanking_test";
const MIGRATION = 502;
const TABLES = [
  "platform.dead_letter_events",
  "platform.domain_events",
  "platform.external_webhook_events",
  "platform.jobs",
  "platform.outbox_events",
  "platform.product_audit_events",
];

// Replica mode skips triggers and keys; checks still apply.
const replica = (sql: string) =>
  `BEGIN; SET LOCAL session_replication_role = replica; ${sql}; COMMIT`;
const filled = `'{"name": "Kept detail"}'::jsonb`;

// VAY-2272: 0502 blanks what kept rows still say about the Marketplace and removed creators.
describe.skipIf(!URL)("Marketplace kept payload blanking 0502", () => {
  it("stops on open queue rows, then blanks the contents and keeps every row", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2272-kept-payloads-"));
    const run = (dir: string) =>
      runMigrations({ connectionString: targetUrl.href, migrationsDir: dir, environment: "local" });
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      let file = "";
      for (const name of await readdir(MIGRATIONS)) {
        if (!/^\d{4}_/.test(name)) continue;
        if (Number(name.slice(0, 4)) < MIGRATION)
          await cp(join(MIGRATIONS, name), join(before, name));
        if (Number(name.slice(0, 4)) === MIGRATION) file = name;
      }
      expect((await run(before)).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;

      // One LOCK covers exactly the tables the migration updates.
      const sql = await readFile(join(MIGRATIONS, file), "utf8");
      const updated = [...sql.matchAll(/^UPDATE ([a-z_]+\.[a-z_]+)/gm)].map((match) => match[1]!);
      const locked = sql
        .slice(sql.indexOf("LOCK TABLE") + "LOCK TABLE".length)
        .split("IN SHARE ROW EXCLUSIVE MODE")[0]!
        .split(",")
        .map((name) => name.trim());
      expect(locked).toEqual([...new Set(updated)].sort());
      expect(locked).toEqual(TABLES);

      const [creatorOrg, hotelOrg, removedUser, hotelUser] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      const id: Record<string, string> = Object.fromEntries(
        [
          "eventMarketplace",
          "eventCreatorOrg",
          "eventRemovedActor",
          "eventHotel",
          "auditMarketplace",
          "auditCreatorOrg",
          "auditRemovedActor",
          "auditHotel",
          "outboxMarketplace",
          "outboxHotel",
          "jobMarketplace",
          "jobCreatorOrg",
          "jobHotel",
          "deadMarketplace",
          "deadIdentity",
          "receiptProcessed",
          "receiptIgnored",
          "receiptUnprocessed",
          "receiptStripe",
        ].map((label) => [label, randomUUID()]),
      ) as Record<string, string>;
      await db.query(
        replica(`
          INSERT INTO identity.organizations (id, kind, name, slug, status) VALUES
            ('${creatorOrg}', 'creator_workspace', 'Removed workspace', 'removed-${creatorOrg}', 'archived'),
            ('${hotelOrg}', 'hotel_group', 'Kept hotel', 'kept-${hotelOrg}', 'active');
          INSERT INTO identity.users (id, email, status) VALUES
            ('${removedUser}', 'removed-${removedUser}@removed.invalid', 'deleted'),
            ('${hotelUser}', 'hotel-${hotelUser}@example.test', 'active');
          INSERT INTO platform.domain_events
            (id, source_system, event_key, event_type, occurred_at, tenant_scope, organization_id,
             actor_type, actor_user_id, resource_product, resource_type, resource_id, payload, event_metadata)
          VALUES
            ('${id.eventMarketplace}', 'marketplace', 'k1', 'marketplace.offer.published', now(), 'platform',
             NULL, 'system', NULL, 'marketplace', 'offer', 'offer-1', ${filled}, ${filled}),
            ('${id.eventCreatorOrg}', 'identity', 'k2', 'identity.organization.updated', now(), 'organization',
             '${creatorOrg}', 'system', NULL, 'identity', 'organization', '${creatorOrg}', ${filled}, '{}'),
            ('${id.eventRemovedActor}', 'booking', 'k3', 'booking.note.added', now(), 'platform', NULL,
             'user', '${removedUser}', 'booking', 'note', 'note-1', ${filled}, '{}'),
            ('${id.eventHotel}', 'booking', 'k4', 'booking.note.added', now(), 'organization', '${hotelOrg}',
             'user', '${hotelUser}', 'booking', 'note', 'note-2', ${filled}, ${filled});
          INSERT INTO platform.product_audit_events
            (id, audit_key, product, action, occurred_at, tenant_scope, organization_id, actor_type,
             actor_user_id, target_resource_product, target_resource_type, target_resource_id,
             redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope)
          VALUES
            ('${id.auditMarketplace}', 'a1', 'marketplace', 'marketplace.offer.published', now(), 'platform',
             NULL, 'system', NULL, 'marketplace', 'offer', 'offer-1', ${filled}, ${filled}, '{}', 'standard',
             'internal'),
            ('${id.auditCreatorOrg}', 'a2', 'identity', 'identity.organization.updated', now(), 'organization',
             '${creatorOrg}', 'system', NULL, 'identity', 'organization', '${creatorOrg}', '{}', ${filled}, '{}',
             'security', 'confidential'),
            ('${id.auditRemovedActor}', 'a3', 'finance', 'finance.payout.viewed', now(), 'platform', NULL,
             'user', '${removedUser}', 'finance', 'payout', 'payout-1', '{}', '{}', ${filled}, 'financial',
             'confidential'),
            ('${id.auditHotel}', 'a4', 'booking', 'booking.note.added', now(), 'organization', '${hotelOrg}',
             'user', '${hotelUser}', 'booking', 'note', 'note-2', ${filled}, ${filled}, ${filled}, 'standard',
             'internal');
          INSERT INTO platform.outbox_events
            (id, domain_event_id, outbox_key, destination, event_type, tenant_scope, organization_id,
             resource_product, status, published_at, payload, outbox_metadata)
          VALUES
            ('${id.outboxMarketplace}', '${id.eventMarketplace}', 'o1', 'marketplace', 'marketplace.offer.published',
             'platform', NULL, 'marketplace', 'published', now(), ${filled}, '{}'),
            ('${id.outboxHotel}', '${id.eventHotel}', 'o2', 'booking', 'booking.note.added', 'organization',
             '${hotelOrg}', 'booking', 'published', now(), ${filled}, ${filled});
          INSERT INTO platform.jobs
            (id, job_key, queue_name, job_type, tenant_scope, organization_id, resource_product, status,
             finished_at, payload, job_metadata)
          VALUES
            ('${id.jobMarketplace}', 'j1', 'marketplace', 'marketplace.offer.index', 'platform', NULL,
             'marketplace', 'succeeded', now(), ${filled}, ${filled}),
            ('${id.jobCreatorOrg}', 'j2', 'identity', 'identity.sync', 'organization', '${creatorOrg}',
             'identity', 'canceled', now(), ${filled}, '{}'),
            ('${id.jobHotel}', 'j3', 'booking', 'booking.reindex', 'organization', '${hotelOrg}', 'booking',
             'succeeded', now(), ${filled}, ${filled});
          INSERT INTO platform.external_webhook_events
            (id, provider, provider_event_id, event_type, payload_hash, delivery_status, raw_headers, raw_payload,
             payload_retention_until)
          VALUES
            ('${id.receiptProcessed}', 'workos', 'w1', 'user.updated', 'h1', 'validated', ${filled}, ${filled},
             NULL),
            ('${id.receiptIgnored}', 'workos', 'w2', 'user.updated', 'h2', 'validated', '{}', ${filled}, NULL),
            ('${id.receiptUnprocessed}', 'workos', 'w3', 'user.updated', 'h3', 'received', ${filled}, ${filled},
             NULL),
            ('${id.receiptStripe}', 'stripe', 's1', 'payout.paid', 'h4', 'ignored', ${filled}, ${filled},
             now() + interval '30 days');
          INSERT INTO identity.auth_reconciliation_events (event_type, provider, provider_event_id) VALUES
            ('workos.webhook.normalized', 'workos', '${id.receiptProcessed}'),
            ('workos.webhook.ignored', 'workos', '${id.receiptIgnored}');
          INSERT INTO platform.dead_letter_events
            (id, source_kind, job_id, webhook_event_id, reason_code, failure_summary, tenant_scope,
             resource_product, failure_payload)
          VALUES
            ('${id.deadMarketplace}', 'job', '${id.jobMarketplace}', NULL, 'failed', 'Marketplace job failed',
             'platform', 'marketplace', ${filled}),
            ('${id.deadIdentity}', 'webhook', NULL, '${id.receiptUnprocessed}', 'failed', 'Invitation failed',
             'external', 'identity', ${filled})`),
      );

      // Which seeded rows hold contents, by label, and how many rows each table has.
      const contents = async () => {
        const result: Record<string, boolean> = {};
        const read = async (table: string, columns: string[]) => {
          const { rows } = await db.query<{ id: string; blank: boolean }>(
            `SELECT id::text, ${columns.map((column) => `${column} = '{}'::jsonb`).join(" AND ")} AS blank
             FROM ${table} WHERE id = ANY($1::uuid[])`,
            [Object.values(id)],
          );
          for (const row of rows) {
            const label = Object.keys(id).find((key) => id[key] === row.id)!;
            result[label] = !row.blank;
          }
        };
        await read("platform.domain_events", ["payload", "event_metadata"]);
        await read("platform.product_audit_events", [
          "redacted_payload",
          "private_payload",
          "audit_metadata",
        ]);
        await read("platform.outbox_events", ["payload", "outbox_metadata"]);
        await read("platform.jobs", ["payload", "job_metadata"]);
        await read("platform.dead_letter_events", ["failure_payload"]);
        await read("platform.external_webhook_events", ["raw_payload", "raw_headers"]);
        const counts: Record<string, number> = {};
        for (const table of TABLES)
          counts[table] = (
            await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)
          ).rows[0]!.n;
        return {
          withContents: Object.keys(result)
            .filter((label) => result[label])
            .sort(),
          counts,
        };
      };
      const seeded = await contents();
      expect(seeded.withContents).toEqual(Object.keys(id).sort());

      // Each gate stops 0502 before it changes anything. Later migrations may change what this
      // checks, so it applies only 0502.
      await cp(join(MIGRATIONS, file), join(before, file));
      const gates: [string, string][] = [
        [
          `INSERT INTO platform.jobs
             (job_key, queue_name, job_type, tenant_scope, resource_product, status)
           VALUES ('gate-job', 'marketplace', 'marketplace.offer.index', 'platform', 'marketplace', 'pending')`,
          `DELETE FROM platform.jobs WHERE job_key = 'gate-job'`,
        ],
        [
          `INSERT INTO platform.outbox_events
             (domain_event_id, outbox_key, destination, event_type, tenant_scope, organization_id,
              resource_product, status, leased_until)
           VALUES ('${id.eventCreatorOrg}', 'gate-outbox', 'identity', 'identity.organization.updated',
                   'organization', '${creatorOrg}', 'identity', 'leased', now() + interval '1 minute')`,
          `DELETE FROM platform.outbox_events WHERE outbox_key = 'gate-outbox'`,
        ],
      ];
      const message = "Marketplace or creator jobs or outbox events are still open";
      for (const [trip, undo] of gates) {
        await db.query(replica(trip));
        expect({ trip, failed: (await run(before)).failed }).toEqual({ trip, failed: "0502" });
        expect(
          (
            await db.query(
              `SELECT failure_reason FROM platform.schema_migrations
               WHERE version = '0502' ORDER BY id DESC LIMIT 1`,
            )
          ).rows,
        ).toEqual([{ failure_reason: message }]);
        await db.query(replica(undo));
        expect({ trip, state: await contents() }).toEqual({ trip, state: seeded });
      }

      expect((await run(before)).failed).toBeNull();

      // Every row stays. Only the hotel's rows, the identity dead letter, the unprocessed WorkOS
      // receipt and the Stripe receipt keep their contents.
      expect(await contents()).toEqual({
        withContents: [
          "auditHotel",
          "deadIdentity",
          "eventHotel",
          "jobHotel",
          "outboxHotel",
          "receiptStripe",
          "receiptUnprocessed",
        ],
        counts: seeded.counts,
      });
      expect(
        (
          await db.query(
            `SELECT payload_purged_at FROM platform.external_webhook_events WHERE id = $1`,
            [id.receiptProcessed],
          )
        ).rows,
      ).toEqual([{ payload_purged_at: null }]);
      // The append-only triggers are back, enabled.
      expect(
        (
          await db.query(
            `SELECT tgname, tgenabled FROM pg_catalog.pg_trigger
             WHERE tgname IN ('trg_platform_domain_events_append_only',
                              'trg_platform_product_audit_events_append_only',
                              'trg_platform_external_webhook_events_append_only')
             ORDER BY 1`,
          )
        ).rows,
      ).toEqual([
        { tgname: "trg_platform_domain_events_append_only", tgenabled: "O" },
        { tgname: "trg_platform_external_webhook_events_append_only", tgenabled: "O" },
        { tgname: "trg_platform_product_audit_events_append_only", tgenabled: "O" },
      ]);
      await expect(
        db.query(`UPDATE platform.domain_events SET payload = '{}'::jsonb WHERE id = $1`, [
          id.eventHotel,
        ]),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 240_000);
});
