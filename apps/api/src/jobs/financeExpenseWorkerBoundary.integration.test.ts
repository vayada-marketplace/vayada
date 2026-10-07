import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertFinanceExpenseWorkerBoundary,
  financeExpenseWorkerPrivileges,
  FINANCE_EXPENSE_WORKER_ROLE as role,
} from "./financeExpenseWorkerBoundary.js";
import {
  discoverFinanceExpenseGenerationJobs,
  enqueueFinanceExpenseGeneration,
  runFinanceExpenseGenerationJobs,
} from "./financeExpenseGeneration.js";

const url = process.env["TEST_DATABASE_URL"];
if (url && !/(^|[_-])(test|verify)([_-]|$)/i.test(new URL(url).pathname))
  throw new Error("Refusing non-test database");
const id = (n: number) => `20440000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const property = id(1),
  other = id(2),
  category = id(3),
  rule = id(4),
  organization = id(5);
describe.skipIf(!url)("Finance expense worker database boundary", () => {
  const admin = new pg.Client({ connectionString: url });
  let worker: pg.Pool;
  let jobId: string;
  beforeAll(async () => {
    await admin.connect();
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} LOGIN PASSWORD 'fixture' NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS; END IF; END $$`,
    );
    const database = (
      await admin.query("SELECT current_database() AS name")
    ).rows[0].name.replaceAll('"', '""');
    await admin.query(
      `REVOKE TEMP ON DATABASE "${database}" FROM PUBLIC; GRANT CONNECT ON DATABASE "${database}" TO ${role}`,
    );
    await assertFinanceExpenseWorkerBoundary(admin, { allowMissingGrants: true });
    await admin.query(
      `GRANT USAGE ON SCHEMA platform,finance,booking,identity,hotel_catalog,pms TO ${role}`,
    );
    for (const [table, privileges] of Object.entries(financeExpenseWorkerPrivileges))
      for (const [kind, columns] of Object.entries(privileges))
        await admin.query(
          `GRANT ${kind}${columns === true ? "" : `(${columns.join(",")})`} ON ${table} TO ${role}`,
        );
    const restricted = new URL(url!);
    restricted.username = role;
    restricted.password = "fixture";
    worker = new pg.Pool({ connectionString: restricted.toString(), max: 3 });
    await admin.query(`
      INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES('${property}','vay2044-a','Worker fixture'),('${other}','vay2044-b','Denied fixture');
      INSERT INTO platform.finance_expense_worker_properties VALUES('${property}');
      INSERT INTO hotel_catalog.property_locations(property_id,timezone) VALUES('${property}','Europe/Berlin');
      INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES('${property}','EUR');
      INSERT INTO finance.expense_categories(id,property_id,name,color) VALUES('${category}','${property}','Fixture','#111111');
      INSERT INTO finance.recurring_expense_rules(id,property_id,category_id,cadence,starts_on,next_due_on,ends_on,vendor,amount,currency,payment_status) VALUES('${rule}','${property}','${category}','weekly','2026-08-20','2026-08-20','2026-08-20','Fixture',10,'EUR','unpaid');
      INSERT INTO identity.organizations(id,kind,name,slug) VALUES('${organization}','hotel_group','Worker fixture','vay2044');
      INSERT INTO identity.users(id,email) VALUES('${id(9)}','pricing-fixture-vay2044@example.test');
      INSERT INTO booking.pricing_authority_revisions(property_id,revision,authority,organization_id,actor_user_id,request_id,request_hash) VALUES('${property}','${id(10)}','vayada','${organization}','${id(9)}','pricing-fixture',repeat('a',64));
      INSERT INTO platform.pricing_runtime_property_scopes(database_login,operation_class,property_id,organization_id) VALUES('vayada_next_pricing_fixture','owner_manage','${property}','${organization}');
      INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship) VALUES('${organization}','pms','pms_property','${property}','owner');
      INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id) VALUES
        ('${organization}','pms','property-management','active','pms','pms_property','${property}'),('${organization}','pms','module:financials','suspended','pms','pms_property','${property}');
      INSERT INTO platform.jobs(id,job_key,queue_name,job_type,tenant_scope,property_id,resource_product) VALUES
        ('${id(6)}','other-queue','booking.other','booking.other','property','${property}','booking'),
        ('${id(7)}','other-property','finance.expense-generation','finance.generate-expense','property','${other}','finance');
      INSERT INTO platform.job_attempts(id,job_id,attempt_number,status,worker_id,started_at) VALUES('${id(8)}','${id(6)}',1,'running','other',now());
    `);
  });
  afterAll(async () => {
    await worker?.end();
    // Disposable fixture cleanup retains immutable rows until the test DB is dropped.
    await admin.end();
  });
  it("logs in as the exact non-owner role and fails closed on property or catalog drift", async () => {
    const client = await worker.connect();
    try {
      expect((await client.query("SELECT current_user,session_user")).rows[0]).toEqual({
        current_user: role,
        session_user: role,
      });
      expect(
        (
          await admin.query(
            `SELECT 1 FROM platform.pricing_runtime_property_scopes scope JOIN booking.pricing_authority_revisions revision ON revision.property_id=scope.property_id AND revision.organization_id=scope.organization_id WHERE scope.database_login='vayada_next_pricing_fixture'`,
          )
        ).rowCount,
      ).toBe(1);
      await expect(
        admin.query(
          "INSERT INTO platform.pricing_runtime_property_scopes(database_login,operation_class,property_id,organization_id) VALUES($1,'owner_manage',$2,$3)",
          [role, property, organization],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      for (const view of [
        "booking.pricing_runtime_effective_property_scopes",
        "booking.pricing_runtime_effective_authority_scopes",
      ])
        expect((await client.query(`SELECT * FROM ${view}`)).rows).toEqual([]);
      await assertFinanceExpenseWorkerBoundary(client, { propertyId: property });
      await expect(
        assertFinanceExpenseWorkerBoundary(client, { propertyId: other }),
      ).rejects.toThrow("property_scope_mismatch");
      for (const sql of [
        `GRANT SELECT ON platform.outbox_events TO ${role}`,
        `GRANT UPDATE(amount) ON finance.expenses TO ${role}`,
        `ALTER TABLE finance.expenses DISABLE ROW LEVEL SECURITY`,
        `ALTER POLICY finance_expense_worker_scope ON platform.jobs USING(true)`,
        `GRANT pg_read_all_data TO ${role}`,
        `GRANT SET ON PARAMETER session_replication_role TO ${role}`,
        `ALTER ROLE ${role} SET session_replication_role=replica`,
        `SET LOCAL session_replication_role=replica`,
        `SET LOCAL search_path=public,pg_catalog`,
        `ALTER FUNCTION platform.finance_expense_worker_scope(text,text,uuid) SECURITY DEFINER`,
        `ALTER VIEW booking.pricing_runtime_effective_property_scopes SET (security_barrier=false)`,
        `ALTER TABLE platform.pricing_runtime_property_scopes DROP CONSTRAINT pricing_runtime_property_scopes_database_login_check`,
      ]) {
        await admin.query("BEGIN");
        try {
          await admin.query(sql);
          await expect(assertFinanceExpenseWorkerBoundary(admin)).rejects.toThrow(
            "finance_worker_",
          );
        } finally {
          await admin.query("ROLLBACK");
        }
      }
    } finally {
      client.release();
    }
  });
  it("preserves existing API reads and identity queue writes without Finance lookup grants", async () => {
    for (const existingRole of ["vayada_next_api_runtime", "vayada_next_identity_runtime"]) {
      await admin.query(
        `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${existingRole}') THEN CREATE ROLE ${existingRole} LOGIN PASSWORD 'fixture' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF; END $$`,
      );
      await admin.query(
        `GRANT USAGE ON SCHEMA platform,identity,finance,pms,hotel_catalog,booking TO ${existingRole}`,
      );
      const tables =
        existingRole === "vayada_next_identity_runtime"
          ? [
              "identity.organizations",
              "identity.organization_resource_links",
              "identity.product_entitlements",
              "platform.jobs",
              "platform.idempotency_keys",
              "platform.dead_letter_events",
              "platform.external_webhook_events",
              "platform.product_audit_events",
            ]
          : Object.keys(financeExpenseWorkerPrivileges).filter(
              (table) => table !== "platform.finance_expense_worker_properties",
            );
      await admin.query(`GRANT SELECT ON ${tables.join(",")} TO ${existingRole}`);
      if (existingRole === "vayada_next_identity_runtime")
        await admin.query(
          `GRANT INSERT,UPDATE ON platform.jobs,platform.idempotency_keys,platform.dead_letter_events,platform.external_webhook_events,identity.organizations,identity.organization_resource_links TO ${existingRole}; GRANT INSERT ON platform.product_audit_events TO ${existingRole}`,
        );
      const connection = new URL(url!);
      connection.username = existingRole;
      connection.password = "fixture";
      const existing = new pg.Client({ connectionString: connection.toString() });
      await existing.connect();
      try {
        expect(
          (
            await existing.query(
              "SELECT has_table_privilege(current_user,'platform.finance_expense_worker_properties','SELECT') AS allowed",
            )
          ).rows[0].allowed,
        ).toBe(false);
        for (const table of tables) await existing.query(`SELECT * FROM ${table} LIMIT 1`);
        if (existingRole === "vayada_next_identity_runtime") {
          await existing.query(
            "INSERT INTO platform.jobs(job_key,queue_name,job_type,resource_product) VALUES('identity-compat','identity.webhooks','identity.workos_webhook.reconcile','identity')",
          );
          await existing.query(
            "INSERT INTO platform.idempotency_keys(operation_scope,operation,key_hash,request_fingerprint_hash,status,expires_at) VALUES('identity','compat',repeat('a',64),repeat('b',64),'in_progress','infinity')",
          );
          await expect(
            existing.query(
              "INSERT INTO platform.jobs(job_key,queue_name,job_type,resource_product) VALUES('identity-denied','finance.expense-generation','finance.generate-expense','finance')",
            ),
          ).rejects.toMatchObject({ code: "42501" });
        } else
          await expect(
            existing.query("UPDATE platform.jobs SET status='running'"),
          ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await existing.end();
      }
    }
  });
  it("discovers and processes allowed work only after entitlement activation, preserving replay", async () => {
    const clock = () => new Date("2026-08-20T12:00:00Z");
    expect(await discoverFinanceExpenseGenerationJobs(worker, { clock })).toBe(0);
    expect((await runFinanceExpenseGenerationJobs(worker, { clock })).succeeded).toBe(0);
    await admin.query(
      "UPDATE identity.product_entitlements SET status='active' WHERE organization_id=$1 AND entitlement_key='module:financials'",
      [organization],
    );
    expect(await discoverFinanceExpenseGenerationJobs(worker, { clock })).toBe(1);
    expect((await runFinanceExpenseGenerationJobs(worker, { clock })).succeeded).toBe(1);
    expect(await discoverFinanceExpenseGenerationJobs(worker, { clock })).toBe(0);
    const rows = (await worker.query("SELECT id FROM platform.jobs")).rows;
    expect(rows).toHaveLength(1);
    jobId = rows[0].id;
    expect((await worker.query("SELECT amount::text FROM finance.expenses")).rows).toEqual([
      { amount: "10.0000" },
    ]);
    expect(
      (await worker.query("SELECT count(*)::int AS count FROM platform.product_audit_events"))
        .rows[0].count,
    ).toBeGreaterThanOrEqual(2);
  });
  it("denies cross-queue/property writes, receipts, identity, outbox, and source edits", async () => {
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
      expect(
        (
          await client.query(
            "SELECT platform.finance_expense_worker_scope('property','not-a-uuid') AS allowed",
          )
        ).rows,
      ).toEqual([{ allowed: false }]);
      for (const table of [
        "platform.outbox_events",
        "identity.users",
        "finance.payments",
        "pms.channex_offer_create_receipts",
        "platform.media_objects",
      ])
        await expect(client.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({
          code: "42501",
        });
      expect(
        (await client.query("SELECT id,provider FROM platform.external_webhook_events")).rows,
      ).toEqual([]);
      expect((await client.query("SELECT id FROM hotel_catalog.properties")).rows).toEqual([
        { id: property },
      ]);
      for (const sql of [
        `UPDATE platform.jobs SET status='running' WHERE id IN ('${id(6)}','${id(7)}')`,
        `UPDATE platform.job_attempts SET status='succeeded' WHERE id='${id(8)}'`,
        `UPDATE platform.jobs SET property_id='${other}' WHERE id='${jobId}'`,
        `UPDATE platform.jobs SET queue_name='booking.other' WHERE id='${jobId}'`,
        `INSERT INTO platform.job_attempts(job_id,attempt_number,status,worker_id,started_at) VALUES('${id(6)}',2,'running','attack',now())`,
        `INSERT INTO platform.finance_expense_worker_properties VALUES('${other}')`,
        `UPDATE hotel_catalog.properties SET id=id WHERE id='${property}'`,
        `UPDATE pms.property_pricing_settings SET property_id=property_id WHERE property_id='${property}'`,
        `UPDATE finance.expense_categories SET id=id WHERE id='${category}'`,
        `UPDATE finance.expenses SET id=id`,
        `UPDATE finance.recurring_expense_rules SET amount=99 WHERE id='${rule}'`,
        `UPDATE identity.product_entitlements SET status='active'`,
        `UPDATE platform.outbox_events SET published_at=now()`,
        `DELETE FROM platform.jobs WHERE id='${jobId}'`,
        `TRUNCATE finance.expenses`,
      ])
        await denied(sql);
      for (const target of [other])
        await expect(
          enqueueFinanceExpenseGeneration(client, {
            family: "recurring",
            propertyId: target,
            dueThrough: "2026-08-20",
            requestId: "denied",
            correlationId: "denied",
            causationId: randomUUID(),
            requestedAt: "2026-08-20T12:00:00.000Z",
          }),
        ).rejects.toMatchObject({ code: "42501" });
      const owner = (await admin.query("SELECT current_user AS name")).rows[0].name.replaceAll(
        '"',
        '""',
      );
      await expect(client.query(`SET ROLE "${owner}"`)).rejects.toMatchObject({ code: "42501" });
      await client.query("BEGIN");
      await client.query("SELECT id FROM hotel_catalog.properties FOR UPDATE");
      await client.query("SELECT id FROM finance.expense_categories FOR SHARE");
      await client.query("SELECT id FROM finance.expenses FOR UPDATE");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
