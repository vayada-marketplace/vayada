import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPgPmsChannexManagementWorkerStore } from "./pmsChannexManagementWorkerStore.js";
import { CHANNEX_JOB_LEASE_MS, lockChannexPricingJobLease } from "./pmsChannexPricingJobLease.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test")) throw new Error("Test database required");
describe.skipIf(!url)("Channex pricing job lease against migrated PostgreSQL", () => {
  const pool = new pg.Pool({ connectionString: url });
  const propertyId = randomUUID();
  let jobId: string;
  const input = () => ({ jobId, workerId: "lease-worker", attemptNumber: 1 });
  const store = createPgPmsChannexManagementWorkerStore({
    connectionString: url ?? "postgresql://disabled/unused_test",
    ariSyncMutating: false,
    targetState: { async succeed() {}, async fail() {} },
  });
  async function clean() {
    await pool.query(
      "DELETE FROM platform.job_attempts WHERE job_id IN (SELECT id FROM platform.jobs WHERE property_id=$1)",
      [propertyId],
    );
    await pool.query("DELETE FROM platform.jobs WHERE property_id=$1", [propertyId]);
  }
  async function read(value = input()) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      return await lockChannexPricingJobLease(client, value);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
  beforeAll(async () => {
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Lease test')",
      [propertyId],
    );
  });
  beforeEach(async () => {
    await clean();
    jobId = randomUUID();
    await pool.query(
      `INSERT INTO platform.jobs(id,job_key,queue_name,job_type,status,attempts_count,locked_by,locked_at,
      tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
      VALUES($1::uuid,$1::text,'pms.channex.management','channex.provision','running',1,'lease-worker',clock_timestamp(),
      'property',$2::uuid,'pms','channex_connection',$2::text,'{"operationType":"provision","commandId":"test","idempotencyKey":"test"}')`,
      [jobId, propertyId],
    );
    await pool.query(
      "INSERT INTO platform.job_attempts(job_id,attempt_number,worker_id) VALUES($1,1,'lease-worker')",
      [jobId],
    );
  });
  afterAll(async () => {
    await clean();
    await pool.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
    await store.close?.();
    await pool.end();
  });
  it.each(["provision", "sync_ari", "update_markups"])(
    "derives persisted %s scope without renewing",
    async (operation) => {
      await pool.query(
        "UPDATE platform.jobs SET job_type='channex.'||$2, payload=jsonb_set(payload,'{operationType}',to_jsonb($2::text)) WHERE id=$1",
        [jobId, operation],
      );
      const before = (await pool.query("SELECT locked_at FROM platform.jobs WHERE id=$1", [jobId]))
        .rows[0];
      expect(await read()).toEqual({ ...input(), propertyId, operationType: operation });
      expect(
        (await pool.query("SELECT locked_at FROM platform.jobs WHERE id=$1", [jobId])).rows[0],
      ).toEqual(before);
    },
  );
  it.each([
    "queue_name='other'",
    "job_type='channex.enable'",
    "resource_product='booking'",
    "resource_type='other'",
    "resource_id='other'",
    "locked_by='other'",
    "status='pending'",
    "payload='{}'",
    "locked_at=clock_timestamp()+interval '1 minute'",
    "locked_at=clock_timestamp()-interval '6 minutes'",
    "finished_at=clock_timestamp()",
  ])("rejects invalid persisted job %s", async (change) => {
    await pool.query(`UPDATE platform.jobs SET ${change} WHERE id=$1`, [jobId]);
    expect(await read()).toBeNull();
  });
  it.each([
    "worker_id='other'",
    "status='timed_out',finished_at=clock_timestamp()",
    "finished_at=clock_timestamp()",
  ])("rejects invalid attempt %s", async (change) => {
    await pool.query(`UPDATE platform.job_attempts SET ${change} WHERE job_id=$1`, [jobId]);
    expect(await read()).toBeNull();
  });
  it("rejects missing attempts and mismatched input", async () => {
    for (const patch of [
      { jobId: "invalid" },
      { jobId: randomUUID() },
      { workerId: "" },
      { workerId: "other" },
      { attemptNumber: 2 },
      { attemptNumber: 1.5 },
      { attemptNumber: Number.MAX_SAFE_INTEGER },
    ]) {
      expect(await read({ ...input(), ...patch })).toBeNull();
    }
    await pool.query("DELETE FROM platform.job_attempts WHERE job_id=$1", [jobId]);
    expect(await read()).toBeNull();
  });
  it("uses wall time after transaction start and never extends expiry", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE platform.jobs SET locked_at=clock_timestamp()-($2::bigint*interval '1 millisecond')+interval '10 milliseconds' WHERE id=$1",
        [jobId, CHANNEX_JOB_LEASE_MS],
      );
      await client.query("SELECT pg_sleep(0.03)");
      expect(await lockChannexPricingJobLease(client, input())).toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("rejects platform tenant scope and ignores payload property/revision claims", async () => {
    await pool.query("UPDATE platform.jobs SET payload=payload || $2::jsonb WHERE id=$1", [
      jobId,
      JSON.stringify({
        propertyId: randomUUID(),
        expectedRevision: 999,
        organizationId: randomUUID(),
      }),
    ]);
    expect(await read()).toEqual({ ...input(), propertyId, operationType: "provision" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE platform.jobs SET tenant_scope='platform',property_id=NULL WHERE id=$1",
        [jobId],
      );
      expect(await lockChannexPricingJobLease(client, input())).toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("accepts real claims and rejects reclaimed attempts even with the same worker", async () => {
    await pool.query("DELETE FROM platform.job_attempts WHERE job_id=$1", [jobId]);
    await pool.query(
      "UPDATE platform.jobs SET status='pending',attempts_count=0,locked_at=NULL,locked_by=NULL WHERE id=$1",
      [jobId],
    );
    const claimed = await store.claim({ workerId: input().workerId, now: new Date() });
    expect(claimed?.jobId).toBe(jobId);
    expect(await read()).toMatchObject({ jobId, propertyId, attemptNumber: 1 });
    await pool.query(
      "UPDATE platform.jobs SET locked_at=clock_timestamp()-interval '6 minutes' WHERE id=$1",
      [jobId],
    );
    const reclaimed = await store.claim({ workerId: input().workerId, now: new Date() });
    expect(reclaimed?.attemptNumber).toBe(2);
    expect(await read()).toBeNull();
    expect(await read({ ...input(), attemptNumber: 2 })).toMatchObject({
      jobId,
      propertyId,
      attemptNumber: 2,
    });
  });
  it("fails nonblocking on concurrent claim locks and releases locks on rollback", async () => {
    const a = await pool.connect(),
      b = await pool.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      await a.query("SELECT id FROM platform.jobs WHERE id=$1 FOR UPDATE", [jobId]);
      await b.query("SET LOCAL statement_timeout='1s'");
      await expect(lockChannexPricingJobLease(b, input())).rejects.toMatchObject({ code: "55P03" });
      await b.query("ROLLBACK");
      await a.query("ROLLBACK");
      await a.query("BEGIN");
      await b.query("BEGIN");
      expect(await lockChannexPricingJobLease(a, input())).not.toBeNull();
      await expect(
        b.query("SELECT id FROM platform.job_attempts WHERE job_id=$1 FOR UPDATE NOWAIT", [jobId]),
      ).rejects.toMatchObject({ code: "55P03" });
      await b.query("ROLLBACK");
      await a.query("ROLLBACK");
      expect(await read()).not.toBeNull();
    } finally {
      await a.query("ROLLBACK");
      await b.query("ROLLBACK");
      a.release();
      b.release();
    }
  });
});
