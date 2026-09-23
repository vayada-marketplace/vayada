import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertFinanceExportWorkerBoundary,
  financeExportWorkerPrivileges,
  FINANCE_EXPORT_WORKER_ROLE as role,
} from "./financeExportWorkerBoundary.js";

const url = process.env["TEST_DATABASE_URL"];
if (url && !/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(url).pathname))
  throw new Error("Refusing non-test database");
const id = (n: number) => `20450000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const property = id(1),
  other = id(2),
  allowedJob = id(3),
  deniedJob = id(4);

describe.skipIf(!url)("Finance export worker database boundary", () => {
  const admin = new pg.Client({ connectionString: url });
  let worker: pg.Pool;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} LOGIN PASSWORD 'finance-export-test' NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS; END IF; END $$`,
    );
    const database = (
      await admin.query("SELECT current_database() AS name")
    ).rows[0].name.replaceAll('"', '""');
    await admin.query(
      `REVOKE TEMP ON DATABASE "${database}" FROM PUBLIC; GRANT CONNECT ON DATABASE "${database}" TO ${role}`,
    );
    await assertFinanceExportWorkerBoundary(admin, { allowMissingGrants: true });
    await admin.query(
      `GRANT USAGE ON SCHEMA platform,finance,hotel_catalog,pms,booking TO ${role}`,
    );
    for (const [table, privileges] of Object.entries(financeExportWorkerPrivileges))
      for (const [kind, columns] of Object.entries(privileges))
        await admin.query(
          `GRANT ${kind}${columns === true ? "" : `(${columns.join(",")})`} ON ${table} TO ${role}`,
        );
    await admin.query(`
      INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES
        ('${property}','vay2045-a','Export worker fixture'),
        ('${other}','vay2045-b','Denied export fixture');
      INSERT INTO platform.finance_export_worker_properties VALUES('${property}');
      INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES
        ('${property}','Europe/Berlin'),('${other}','Etc/UTC');
      INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES
        ('${property}','EUR'),('${other}','USD');
      INSERT INTO platform.jobs(id,job_key,queue_name,job_type,tenant_scope,property_id,resource_product,resource_type,resource_id) VALUES
        ('${allowedJob}','allowed-export','finance.financials-exports','finance.folio-csv-export.v1','property','${property}','finance','financials_export','${allowedJob}'),
        ('${deniedJob}','other-export','finance.financials-exports','finance.folio-csv-export.v1','property','${other}','finance','financials_export','${deniedJob}');
    `);
    const restricted = new URL(url!);
    restricted.username = role;
    restricted.password = "finance-export-test";
    worker = new pg.Pool({ connectionString: restricted.toString(), max: 2 });
  });

  afterAll(async () => {
    await worker?.end();
    await admin.query("DELETE FROM platform.jobs WHERE id IN($1,$2)", [allowedJob, deniedJob]);
    await admin.query("DELETE FROM pms.property_pricing_settings WHERE property_id IN($1,$2)", [
      property,
      other,
    ]);
    await admin.query("DELETE FROM hotel_catalog.property_locations WHERE property_id IN($1,$2)", [
      property,
      other,
    ]);
    await admin.query(
      "DELETE FROM platform.finance_export_worker_properties WHERE property_id=$1",
      [property],
    );
    await admin.query("DELETE FROM hotel_catalog.properties WHERE id IN($1,$2)", [property, other]);
    await admin.end();
  });

  it("logs in as the exact role and fails closed on contract drift", async () => {
    const client = await worker.connect();
    try {
      expect((await client.query("SELECT current_user,session_user")).rows[0]).toEqual({
        current_user: role,
        session_user: role,
      });
      await assertFinanceExportWorkerBoundary(client, { propertyId: property });
      await expect(
        assertFinanceExportWorkerBoundary(client, { propertyId: other }),
      ).rejects.toThrow("property_scope_mismatch");
      for (const sql of [
        `GRANT SELECT ON platform.outbox_events TO ${role}`,
        `GRANT SELECT(receipt_media_id) ON finance.expenses TO ${role}`,
        `ALTER TABLE platform.jobs DISABLE ROW LEVEL SECURITY`,
        `ALTER POLICY finance_export_worker_scope ON platform.jobs USING(true)`,
        `GRANT pg_read_all_data TO ${role}`,
        `ALTER FUNCTION platform.finance_export_worker_scope(text,text,uuid) SECURITY DEFINER`,
      ]) {
        await admin.query("BEGIN");
        try {
          await admin.query(sql);
          await expect(assertFinanceExportWorkerBoundary(admin)).rejects.toThrow(
            "finance_export_worker_",
          );
        } finally {
          await admin.query("ROLLBACK");
        }
      }
    } finally {
      client.release();
    }
  });

  it("sees only the approved property and exact export queue", async () => {
    expect((await worker.query("SELECT id FROM hotel_catalog.properties")).rows).toEqual([
      { id: property },
    ]);
    expect(
      (await worker.query("SELECT property_id FROM pms.property_pricing_settings")).rows,
    ).toEqual([{ property_id: property }]);
    expect((await worker.query("SELECT id FROM platform.jobs")).rows).toEqual([{ id: allowedJob }]);
    await expect(
      worker.query("SELECT id,provider FROM platform.external_webhook_events"),
    ).rejects.toMatchObject({ code: "42501" });
    expect(
      (await worker.query("SELECT * FROM booking.pricing_runtime_effective_property_scopes")).rows,
    ).toEqual([]);
    await expect(
      worker.query(
        "UPDATE platform.jobs SET status='running',locked_at=now(),locked_by='test-worker' WHERE id=$1",
        [allowedJob],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      worker.query(
        "UPDATE platform.jobs SET status='running',locked_at=now(),locked_by='test-worker' WHERE id=$1",
        [deniedJob],
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("denies receipts, unrelated domains, source writes, and privilege escalation", async () => {
    const client = await worker.connect();
    const denied = async (sql: string) => {
      await client.query("BEGIN");
      try {
        const result = await client.query(sql);
        expect(result.rowCount).toBe(0);
      } catch (error) {
        expect(["42501", "23514", "55000"]).toContain((error as { code: string }).code);
      } finally {
        await client.query("ROLLBACK");
      }
    };
    try {
      for (const sql of [
        "SELECT receipt_media_id FROM finance.expenses",
        "SELECT entry_kind FROM finance.expenses",
        "SELECT recipient_fingerprint FROM finance.folio_revisions",
        "SELECT property_id FROM finance.folio_lines",
        "SELECT finished_at FROM platform.jobs",
        "SELECT worker_id FROM platform.job_attempts",
        "SELECT * FROM finance.payments",
        "SELECT * FROM identity.users",
        "SELECT * FROM booking.guest_bookings",
        "SELECT * FROM platform.outbox_events",
      ])
        await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" });
      for (const sql of [
        `UPDATE hotel_catalog.properties SET id=id WHERE id='${property}'`,
        `UPDATE finance.expenses SET amount=amount`,
        `INSERT INTO platform.finance_export_worker_properties VALUES('${other}')`,
        `UPDATE platform.jobs SET property_id='${other}' WHERE id='${allowedJob}'`,
        `UPDATE platform.jobs SET queue_name='booking.other' WHERE id='${allowedJob}'`,
        `DELETE FROM platform.jobs WHERE id='${allowedJob}'`,
        "TRUNCATE platform.jobs",
      ])
        await denied(sql);
      const owner = (await admin.query("SELECT current_user AS name")).rows[0].name.replaceAll(
        '"',
        '""',
      );
      await expect(client.query(`SET ROLE "${owner}"`)).rejects.toMatchObject({ code: "42501" });
    } finally {
      client.release();
    }
  });

  it("keeps the API runtime unable to claim export work", async () => {
    const apiRole = "vayada_next_api_runtime";
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${apiRole}') THEN CREATE ROLE ${apiRole} LOGIN PASSWORD 'fixture' NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS; END IF; END $$`,
    );
    await admin.query(
      `GRANT USAGE ON SCHEMA platform TO ${apiRole}; GRANT INSERT ON platform.jobs TO ${apiRole}`,
    );
    const connection = new URL(url!);
    connection.username = apiRole;
    connection.password = "fixture";
    const api = new pg.Client({ connectionString: connection.toString() });
    await api.connect();
    try {
      await expect(api.query("UPDATE platform.jobs SET status='running'")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await api.end();
    }
  });
});
