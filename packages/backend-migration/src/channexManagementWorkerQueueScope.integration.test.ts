import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

const url = process.env.TEST_DATABASE_URL;
if (url) assertSafeTestDatabase(url);
const role = "vayada_next_channex_management_worker";
const property = randomUUID(),
  other = randomUUID();
const allowed = randomUUID(),
  deniedQueue = randomUUID(),
  deniedProperty = randomUUID();
const tables = [
  "jobs",
  "job_attempts",
  "dead_letter_events",
  "idempotency_keys",
  "product_audit_events",
];

describe.skipIf(!url)("Channex management shared queue boundary", () => {
  const owner = new pg.Client({ connectionString: url });
  let worker: pg.Client;
  let workerCreated = false;
  beforeAll(async () => {
    await owner.connect();
    // This fixture deliberately grants broader table privileges than deployment
    // will permit, proving that RLS itself enforces the queue/property boundary.
    await owner.query(
      `CREATE ROLE ${role} LOGIN PASSWORD 'fixture' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    workerCreated = true;
    await owner.query(`GRANT USAGE ON SCHEMA platform TO ${role}`);
    await owner.query(`GRANT SELECT ON platform.channex_management_worker_properties TO ${role}`);
    await owner.query(`GRANT SELECT(id,provider) ON platform.external_webhook_events TO ${role}`);
    for (const table of tables)
      await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON platform.${table} TO ${role}`);
    await owner.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Worker test'),($2::uuid,$2::text,'Denied test')",
      [property, other],
    );
    for (const [id, scope, queue] of [
      [allowed, property, "pms.channex.management"],
      [deniedQueue, property, "unrelated"],
      [deniedProperty, other, "pms.channex.management"],
    ])
      await owner.query(
        `INSERT INTO platform.jobs(id,job_key,queue_name,job_type,tenant_scope,property_id,resource_product,resource_type,resource_id,payload,idempotency_key_hash)
        VALUES($1::uuid,$1::text,$3,'channex.sync_ari','property',$2::uuid,'pms','channex_connection',$2::text,'{"operationType":"sync_ari"}',repeat('a',64))`,
        [id, scope, queue],
      );
    await owner.query(
      `INSERT INTO platform.external_webhook_events(provider,provider_event_id,event_type,payload_hash,raw_payload)
      VALUES('channex',$1,'fixture',repeat('a',64),'{}')`,
      [randomUUID()],
    );
    const login = new URL(url!);
    login.username = role;
    login.password = "fixture";
    worker = new pg.Client({ connectionString: login.toString() });
    await worker.connect();
  });
  afterAll(async () => {
    await worker?.end();
    if (workerCreated) {
      await owner.query("DELETE FROM platform.jobs WHERE id=ANY($1::uuid[])", [
        [allowed, deniedQueue, deniedProperty],
      ]);
      await owner.query(
        "DELETE FROM platform.channex_management_worker_properties WHERE property_id=$1",
        [property],
      );
      await owner.query("DELETE FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])", [
        [property, other],
      ]);
      await owner.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    }
    // Append-only synthetic webhook evidence remains until the test DB is dropped.
    await owner.end();
  });

  async function denied(sql: string, values: unknown[] = []) {
    await worker.query("BEGIN");
    try {
      await expect(worker.query(sql, values)).rejects.toMatchObject({ code: "42501" });
    } finally {
      await worker.query("ROLLBACK");
    }
  }

  it("uses the exact non-owner login and defaults to no enabled properties", async () => {
    expect((await worker.query("SELECT current_user,session_user")).rows[0]).toEqual({
      current_user: role,
      session_user: role,
    });
    expect((await worker.query("SELECT id FROM platform.jobs")).rows).toEqual([]);
    await denied("INSERT INTO platform.channex_management_worker_properties VALUES($1)", [
      property,
    ]);
    await owner.query("INSERT INTO platform.channex_management_worker_properties VALUES($1)", [
      property,
    ]);
    expect((await worker.query("SELECT id FROM platform.jobs")).rows).toEqual([{ id: allowed }]);
  });

  it("allows claim, heartbeat, retry, continuation and completion only for scoped jobs", async () => {
    await worker.query("BEGIN");
    const claimed = await worker.query("SELECT id FROM platform.jobs FOR UPDATE SKIP LOCKED");
    expect(claimed.rows).toEqual([{ id: allowed }]);
    await worker.query(
      "UPDATE platform.jobs SET status='running',attempts_count=1,locked_by='fixture',locked_at=now() WHERE id=$1",
      [allowed],
    );
    await worker.query("UPDATE platform.jobs SET locked_at=now(),updated_at=now() WHERE id=$1", [
      allowed,
    ]);
    await worker.query(
      "INSERT INTO platform.job_attempts(job_id,attempt_number,worker_id) VALUES($1,1,'fixture')",
      [allowed],
    );
    await worker.query(
      "UPDATE platform.job_attempts SET status='succeeded',finished_at=now() WHERE job_id=$1",
      [allowed],
    );
    await worker.query(
      "UPDATE platform.jobs SET status='pending',max_attempts=max_attempts+1,locked_at=NULL,locked_by=NULL WHERE id=$1",
      [allowed],
    );
    await worker.query(
      "UPDATE platform.jobs SET status='succeeded',finished_at=now() WHERE id=$1",
      [allowed],
    );
    expect(
      (
        await worker.query("UPDATE platform.jobs SET priority=priority+1 WHERE id IN ($1,$2)", [
          deniedQueue,
          deniedProperty,
        ])
      ).rowCount,
    ).toBe(0);
    await worker.query("ROLLBACK");
  });

  it("denies retargeting jobs or attaching attempts to invisible jobs", async () => {
    for (const [column, value] of [
      ["queue_name", "finance.expense-generation"],
      ["property_id", other],
      ["resource_id", other],
      ["job_type", "channex.enable"],
      ["payload", '{"operationType":"enable"}'],
    ])
      await denied(`UPDATE platform.jobs SET ${column}=$1 WHERE id=$2`, [value, allowed]);
    for (const id of [deniedQueue, deniedProperty])
      await denied(
        "INSERT INTO platform.job_attempts(job_id,attempt_number,worker_id) VALUES($1,1,'fixture')",
        [id],
      );
  });

  it("permits only selected-offer provisioning and ARI enqueue", async () => {
    const enqueue = `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
      VALUES($1,'pms.channex.management',$2,'property',$3::uuid,'pms','channex_connection',$3::text,$4::jsonb)`;
    for (const payload of [
      { operationType: "provision", publishedOffer: {} },
      { operationType: "sync_ari", restrictionsOnly: true },
    ]) {
      await worker.query("BEGIN");
      await worker.query(enqueue, [
        randomUUID(),
        `channex.${payload.operationType}`,
        property,
        JSON.stringify(payload),
      ]);
      await worker.query("ROLLBACK");
    }
    for (const payload of [
      { operationType: "sync_ari", recoveryAlertId: randomUUID() },
      { operationType: "enable" },
      { operationType: "sync_bookings" },
      { operationType: "provision" },
      { operationType: "provision", publishedOffer: null },
      { operationType: "provision", publishedOffer: {}, mealRatePlanId: randomUUID() },
    ])
      await denied(enqueue, [
        randomUUID(),
        `channex.${payload.operationType}`,
        property,
        JSON.stringify(payload),
      ]);
  });

  it("scopes failure, audit and idempotency writes to the reviewed path", async () => {
    const dead = `INSERT INTO platform.dead_letter_events(source_kind,job_id,tenant_scope,property_id,resource_product,resource_type,resource_id,reason_code,failure_summary)
      VALUES('job',$1,'property',$2::uuid,'pms','channex_connection',$2::text,'non_retryable_error','fixture')`;
    const audit = `INSERT INTO platform.product_audit_events(occurred_at,audit_key,product,action,tenant_scope,property_id,actor_type,target_resource_product,target_resource_type,target_resource_id,job_id)
      VALUES(now(),$1,'pms',$2,'property',$3::uuid,'system','pms','channex_connection',$3::text,$4)`;
    const key = `INSERT INTO platform.idempotency_keys(operation_scope,operation,key_hash,request_fingerprint_hash,tenant_scope,property_id,expires_at)
      VALUES('pms',$1,repeat('a',64),repeat('b',64),'property',$2,'infinity')`;
    await worker.query("BEGIN");
    await worker.query(dead, [allowed, property]);
    await worker.query(audit, [randomUUID(), "pms.channex.sync_ari.failed", property, allowed]);
    await worker.query(key, ["channex_management", property]);
    await worker.query("ROLLBACK");
    await denied(dead, [deniedQueue, property]);
    await denied(dead, [deniedProperty, other]);
    await denied(audit, [randomUUID(), "pms.channex.sync_ari.failed", property, deniedQueue]);
    await denied(audit, [randomUUID(), "pms.unrelated", property, allowed]);
    await denied(key, ["unrelated", property]);
    await denied(key, ["channex_management", other]);
    expect((await worker.query("SELECT id FROM platform.external_webhook_events")).rows).toEqual(
      [],
    );
    await denied("UPDATE platform.external_webhook_events SET provider='channex'");
    await owner.query(
      `GRANT UPDATE(delivery_status) ON platform.external_webhook_events TO ${role}`,
    );
    try {
      expect(
        (
          await worker.query(
            "UPDATE platform.external_webhook_events SET delivery_status='ignored'",
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await owner.query(
            "SELECT id FROM platform.external_webhook_events WHERE provider='channex'",
          )
        ).rowCount,
      ).toBeGreaterThan(0);
    } finally {
      await owner.query(
        `REVOKE UPDATE(delivery_status) ON platform.external_webhook_events FROM ${role}`,
      );
    }
  });

  it("preserves existing identity policies without granting access to the worker allowlist", async () => {
    const identity = "vayada_next_identity_runtime";
    await owner.query("BEGIN");
    try {
      if (!(await owner.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [identity])).rowCount)
        await owner.query(`CREATE ROLE ${identity} NOLOGIN NOINHERIT`);
      await owner.query(
        `GRANT USAGE ON SCHEMA platform TO ${identity}; GRANT SELECT,INSERT ON platform.jobs TO ${identity}`,
      );
      // RLS uses current_user; keep any existing login and grants untouched.
      await owner.query(`SET ROLE ${identity}`);
      expect((await owner.query("SELECT current_user")).rows[0].current_user).toBe(identity);
      await owner.query(
        "INSERT INTO platform.jobs(job_key,queue_name,job_type,resource_product) VALUES($1,'identity.webhooks','identity.workos_webhook.reconcile','identity')",
        [randomUUID()],
      );
      expect(
        (await owner.query("SELECT id FROM platform.jobs WHERE id=$1", [allowed])).rows,
      ).toEqual([]);
      await owner.query("SAVEPOINT denied");
      await expect(
        owner.query("SELECT * FROM platform.channex_management_worker_properties"),
      ).rejects.toMatchObject({ code: "42501" });
      await owner.query("ROLLBACK TO SAVEPOINT denied");
      await expect(
        owner.query(
          "INSERT INTO platform.jobs(job_key,queue_name,job_type,resource_product) VALUES($1,'pms.channex.management','channex.sync_ari','pms')",
          [randomUUID()],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await owner.query("ROLLBACK");
      await owner.query("RESET ROLE");
    }
  });
});
