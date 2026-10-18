import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const MIGRATIONS = join(import.meta.dirname, "../migrations");
const DATABASE = "vayada_contact_log_blanking_test";
const BLANKING = "0495_contact_intake_log_blanking.sql";

const PERSONAL = {
  name: "Ana Host",
  email: "ana@example.com",
  phone: "+351 912",
  company: "Casa Ana",
  country: "PT",
  userType: "hotel",
  message: "We have 12 rooms",
};
const OLD_REDACTED = {
  emailDomain: "example.com",
  hasPhone: true,
  hasCompany: true,
  country: "PT",
  userType: "hotel",
  messageLength: 16,
};

// VAY-2286: contact and support messages written before the API kept them only in the job row.
describe.skipIf(!URL)("contact intake log blanking 0495", () => {
  it("empties old contact rows in the append-only log, leaves the rest, triggers unchanged", async () => {
    assertSafeTestDatabase(URL!);
    const admin = new pg.Client({ connectionString: URL });
    const targetUrl = new globalThis.URL(URL!);
    targetUrl.pathname = `/${DATABASE}`;
    const before = await mkdtemp(join(tmpdir(), "vayada-2286-blank-"));
    const run = () =>
      runMigrations({
        connectionString: targetUrl.href,
        migrationsDir: before,
        environment: "local",
      });
    let target: pg.Client | undefined;
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
      for (const file of await readdir(MIGRATIONS))
        if (/^\d{4}_/.test(file) && Number(file.slice(0, 4)) < 495)
          await cp(join(MIGRATIONS, file), join(before, file));
      expect((await run()).failed).toBeNull();
      target = new pg.Client({ connectionString: targetUrl.href });
      await target.connect();
      const db = target;

      const triggers = async () =>
        (
          await db.query(
            `SELECT tgrelid::regclass::text AS relation, tgname, tgenabled,
               pg_get_triggerdef(oid) AS definition
             FROM pg_trigger
             WHERE tgrelid IN ('platform.domain_events'::regclass, 'platform.product_audit_events'::regclass)
               AND NOT tgisinternal
             ORDER BY 1, 2`,
          )
        ).rows;
      const triggersBefore = await triggers();
      expect(triggersBefore.map((row) => row.tgenabled)).toEqual(["O", "O"]);

      let key = 0;
      const event = async (eventType: string, payload: object, metadata: object, age: string) =>
        (
          await db.query<{ id: string }>(
            `INSERT INTO platform.domain_events (
               source_system, event_key, event_type, occurred_at, recorded_at, tenant_scope,
               resource_product, resource_type, resource_id, payload, event_metadata, privacy_scope
             ) VALUES ('platform', $1, $2, now() - $5::interval, now() - $5::interval, 'platform',
               'platform', 'contact_submission', $1, $3::jsonb, $4::jsonb, 'confidential')
             RETURNING id`,
            [
              `test-${(key += 1)}`,
              eventType,
              JSON.stringify(payload),
              JSON.stringify(metadata),
              age,
            ],
          )
        ).rows[0]!.id;
      const audit = async (action: string, redacted: object, privatePart: object) =>
        (
          await db.query<{ id: string }>(
            `INSERT INTO platform.product_audit_events (
               audit_key, product, action, occurred_at, tenant_scope, actor_type,
               target_resource_product, target_resource_type, target_resource_id,
               redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope
             ) VALUES ($1, 'platform', $2, now(), 'platform', 'system', 'platform',
               'contact_submission', $1, $3::jsonb, $4::jsonb, '{}', 'standard', 'confidential')
             RETURNING id`,
            [`test-${(key += 1)}`, action, JSON.stringify(redacted), JSON.stringify(privatePart)],
          )
        ).rows[0]!.id;
      const received = "platform.contact_submission.received";
      const metadata = { contractVersion: "pl1-non-media.v1", redacted: OLD_REDACTED };

      const oldEvents = [
        await event(received, PERSONAL, metadata, "2 hours"),
        await event(received, { ...PERSONAL, userType: "support" }, metadata, "40 days"),
      ];
      const oldAudits = [await audit(received, OLD_REDACTED, PERSONAL)];
      const keptEvents = [
        await event(received, { channel: "contact_form" }, { contractVersion: "v1" }, "2 hours"),
        await event("platform.other", PERSONAL, {}, "2 hours"),
      ];
      const keptAudits = [
        await audit(received, { channel: "contact_form", outcome: "accepted" }, {}),
        await audit("platform.other", OLD_REDACTED, PERSONAL),
      ];
      const rows = async (table: string, ids: string[]) =>
        (await db.query(`SELECT * FROM ${table} WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]))
          .rows;
      const eventsBefore = await rows("platform.domain_events", oldEvents);
      const keptEventsBefore = await rows("platform.domain_events", keptEvents);
      const auditsBefore = await rows("platform.product_audit_events", oldAudits);
      const keptAuditsBefore = await rows("platform.product_audit_events", keptAudits);

      // While the old API still logs messages with their fields, the migration refuses to run.
      const recent = await event(received, PERSONAL, metadata, "1 minute");
      await cp(join(MIGRATIONS, BLANKING), join(before, BLANKING));
      expect((await run()).failed).toBe("0495");
      expect(await triggers()).toEqual(triggersBefore);
      await db.query("SET session_replication_role = replica");
      await db.query("DELETE FROM platform.domain_events WHERE id=$1", [recent]);
      await db.query("RESET session_replication_role");

      expect((await run()).applied).toEqual(["0495"]);

      expect(await rows("platform.domain_events", oldEvents)).toEqual(
        eventsBefore.map((row) => ({
          ...row,
          payload: {},
          event_metadata: { contractVersion: "pl1-non-media.v1" },
        })),
      );
      expect(await rows("platform.product_audit_events", oldAudits)).toEqual(
        auditsBefore.map((row) => ({ ...row, redacted_payload: {}, private_payload: {} })),
      );
      expect(await rows("platform.domain_events", keptEvents)).toEqual(keptEventsBefore);
      expect(await rows("platform.product_audit_events", keptAudits)).toEqual(keptAuditsBefore);
      const leftovers = await db.query(
        `SELECT count(*)::int AS count FROM platform.domain_events t
         WHERE event_type = $1 AND t::text LIKE '%ana@example.com%'`,
        [received],
      );
      expect(leftovers.rows).toEqual([{ count: 0 }]);

      // The triggers are back exactly as they were, and the log is append-only again.
      expect(await triggers()).toEqual(triggersBefore);
      await expect(
        db.query("UPDATE platform.domain_events SET payload = '{}' WHERE id=$1", [keptEvents[1]]),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        db.query("DELETE FROM platform.product_audit_events WHERE id=$1", [oldAudits[0]]),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await target?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await admin.end();
      await rm(before, { recursive: true, force: true });
    }
  }, 120_000);
});
