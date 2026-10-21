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
// Rows that keep their contents; every other seeded row is blanked.
const KEPT = [
  "auditCreatorFinancial",
  "auditHotel",
  "auditHotelRemovedActor",
  "deadForOpen",
  "deadForResolved",
  "deadIdentity",
  "eventCreatorFinance",
  "eventHotel",
  "eventHotelRemovedActor",
  "jobHotel",
  "outboxHotel",
  "receiptDeadOpen",
  "receiptStripe",
  "receiptUnprocessed",
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
        const version = Number(name.slice(0, 4));
        // Production applies 0502 after 0503 and 0504, which were live before W3.
        if (version < MIGRATION || version > 502)
          await cp(join(MIGRATIONS, name), join(before, name));
        if (version === MIGRATION) file = name;
      }
      expect((await run(before)).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;

      // The LOCK covers exactly the tables whose triggers are switched; the others take row locks.
      const sql = await readFile(join(MIGRATIONS, file), "utf8");
      const switched = [...sql.matchAll(/^ALTER TABLE ([a-z_]+\.[a-z_]+) DISABLE TRIGGER/gm)].map(
        (match) => match[1]!,
      );
      const locked = sql
        .slice(sql.indexOf("LOCK TABLE") + "LOCK TABLE".length)
        .split("IN SHARE ROW EXCLUSIVE MODE")[0]!
        .split(",")
        .map((name) => name.trim());
      expect(locked).toEqual([...switched].sort());

      const [creatorOrg, hotelOrg, removedUser, hotelUser, property] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      const id: Record<string, string> = Object.fromEntries(
        [
          ...KEPT,
          "auditCreatorOrg",
          "auditMarketplace",
          "auditRemovedActor",
          "deadMarketplace",
          "eventCreatorOrg",
          "eventMarketplace",
          "eventRemovedActor",
          "jobCreatorOrg",
          "jobMarketplace",
          "outboxMarketplace",
          "receiptDeadResolved",
          "receiptIgnored",
          "receiptProcessed",
        ].map((label) => [label, randomUUID()]),
      ) as Record<string, string>;
      // A removed user's rows in a hotel's history and a creator workspace's finance rows keep their
      // contents; so do receipts no marker names or whose dead letter is still open.
      await db.query(
        replica(`
          INSERT INTO identity.organizations (id, kind, name, slug, status) VALUES
            ('${creatorOrg}', 'creator_workspace', 'Payee workspace', 'payee-${creatorOrg}', 'archived'),
            ('${hotelOrg}', 'hotel_group', 'Kept hotel', 'kept-${hotelOrg}', 'active');
          INSERT INTO identity.users (id, email, status) VALUES
            ('${removedUser}', 'removed-${removedUser}@removed.invalid', 'deleted'),
            ('${hotelUser}', 'hotel-${hotelUser}@example.test', 'active');
          INSERT INTO platform.domain_events
            (id, source_system, event_key, event_type, occurred_at, tenant_scope, organization_id,
             property_id, actor_type, actor_user_id, resource_product, resource_type, resource_id, payload,
             event_metadata)
          VALUES
            ('${id.eventMarketplace}', 'marketplace', 'k1', 'marketplace.offer.published', now(), 'platform',
             NULL, NULL, 'system', NULL, 'marketplace', 'offer', 'offer-1', ${filled}, ${filled}),
            ('${id.eventCreatorOrg}', 'identity', 'k2', 'identity.organization.updated', now(), 'organization',
             '${creatorOrg}', NULL, 'system', NULL, 'identity', 'organization', '${creatorOrg}', ${filled}, '{}'),
            ('${id.eventRemovedActor}', 'identity', 'k3', 'identity.user.updated', now(), 'platform', NULL,
             NULL, 'user', '${removedUser}', 'identity', 'user', '${removedUser}', ${filled}, '{}'),
            ('${id.eventHotel}', 'booking', 'k4', 'booking.note.added', now(), 'organization', '${hotelOrg}',
             NULL, 'user', '${hotelUser}', 'booking', 'note', 'note-1', ${filled}, ${filled}),
            ('${id.eventHotelRemovedActor}', 'pms', 'k5', 'pms.room.assigned', now(), 'property', NULL,
             '${property}', 'user', '${removedUser}', 'pms', 'room', 'room-1', ${filled}, '{}'),
            ('${id.eventCreatorFinance}', 'finance', 'k6', 'finance.payout.paid', now(), 'organization',
             '${creatorOrg}', NULL, 'system', NULL, 'finance', 'payout', 'payout-1', ${filled}, '{}');
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
            ('${id.auditRemovedActor}', 'a3', 'identity', 'identity.user.updated', now(), 'platform', NULL,
             'user', '${removedUser}', 'identity', 'user', '${removedUser}', '{}', '{}', ${filled}, 'security',
             'confidential'),
            ('${id.auditHotel}', 'a4', 'booking', 'booking.note.added', now(), 'organization', '${hotelOrg}',
             'user', '${hotelUser}', 'booking', 'note', 'note-1', ${filled}, ${filled}, ${filled}, 'standard',
             'internal'),
            ('${id.auditHotelRemovedActor}', 'a5', 'booking', 'booking.note.edited', now(), 'organization',
             '${hotelOrg}', 'user', '${removedUser}', 'booking', 'note', 'note-1', ${filled}, '{}', '{}',
             'standard', 'internal'),
            ('${id.auditCreatorFinancial}', 'a6', 'finance', 'finance.payout.paid', now(), 'organization',
             '${creatorOrg}', 'system', NULL, 'finance', 'payout', 'payout-1', ${filled}, '{}', '{}',
             'financial', 'confidential');
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
            ('${id.receiptDeadResolved}', 'workos', 'w3', 'invitation.accepted', 'h3', 'validated', ${filled},
             ${filled}, NULL),
            ('${id.receiptDeadOpen}', 'workos', 'w4', 'invitation.accepted', 'h4', 'validated', ${filled},
             ${filled}, NULL),
            ('${id.receiptUnprocessed}', 'workos', 'w5', 'user.updated', 'h5', 'received', ${filled}, ${filled},
             NULL),
            ('${id.receiptStripe}', 'stripe', 's1', 'payout.paid', 'h6', 'ignored', ${filled}, ${filled},
             now() + interval '30 days');
          INSERT INTO identity.auth_reconciliation_events (event_type, provider, provider_event_id) VALUES
            ('workos.webhook.normalized', 'workos', '${id.receiptProcessed}'),
            ('workos.webhook.ignored', 'workos', '${id.receiptIgnored}'),
            ('workos.webhook.dead_lettered', 'workos', '${id.receiptDeadResolved}'),
            ('workos.webhook.dead_lettered', 'workos', '${id.receiptDeadOpen}');
          INSERT INTO platform.dead_letter_events
            (id, source_kind, job_id, webhook_event_id, reason_code, failure_summary, tenant_scope,
             resource_product, failure_payload, recovery_status, resolved_at)
          VALUES
            ('${id.deadMarketplace}', 'job', '${id.jobMarketplace}', NULL, 'failed', 'Marketplace job failed',
             'platform', 'marketplace', ${filled}, 'open', NULL),
            ('${id.deadIdentity}', 'webhook', NULL, '${id.receiptUnprocessed}', 'failed', 'Invitation failed',
             'external', 'identity', ${filled}, 'open', NULL),
            ('${id.deadForResolved}', 'webhook', NULL, '${id.receiptDeadResolved}', 'failed', 'Invitation failed',
             'external', 'identity', ${filled}, 'resolved', now()),
            ('${id.deadForOpen}', 'webhook', NULL, '${id.receiptDeadOpen}', 'failed', 'Invitation failed',
             'external', 'identity', ${filled}, 'open', NULL)`),
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
           VALUES ('gate-job-1', 'marketplace', 'marketplace.offer.index', 'platform', 'marketplace', 'pending')`,
          `DELETE FROM platform.jobs WHERE job_key = 'gate-job-1'`,
        ],
        [
          `INSERT INTO platform.jobs
             (job_key, queue_name, job_type, tenant_scope, organization_id, resource_product, status,
              locked_at, locked_by)
           VALUES ('gate-job-2', 'identity', 'identity.sync', 'organization', '${creatorOrg}', 'identity',
                   'running', now(), 'worker-1')`,
          `DELETE FROM platform.jobs WHERE job_key = 'gate-job-2'`,
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

      // Every row stays; exactly the expected rows keep their contents.
      expect(await contents()).toEqual({ withContents: KEPT, counts: seeded.counts });
      expect(
        (
          await db.query(
            `SELECT count(*)::int AS n FROM platform.external_webhook_events
             WHERE id = ANY($1::uuid[]) AND payload_purged_at IS NOT NULL`,
            [[id.receiptProcessed, id.receiptIgnored, id.receiptDeadResolved]],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      // The append-only triggers are back, enabled, and refuse changes again.
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
      for (const [table, column, row] of [
        ["platform.domain_events", "payload", id.eventHotel],
        ["platform.product_audit_events", "redacted_payload", id.auditHotel],
        ["platform.external_webhook_events", "raw_payload", id.receiptUnprocessed],
      ] as const)
        await expect(
          db.query(`UPDATE ${table} SET ${column} = '{}'::jsonb WHERE id = $1`, [row]),
          table,
        ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 240_000);
});
