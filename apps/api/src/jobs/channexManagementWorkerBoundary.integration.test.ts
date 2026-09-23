import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHANNEX_MANAGEMENT_WORKER_ROLE as role,
  channexManagementWorkerPrivileges as privileges,
} from "./channexManagementWorkerPrivileges.js";
import { preflightChannexManagementWorker } from "./channexManagementWorkerStartup.js";
import {
  assertChannexManagementWorkerBoundary,
  channexManagementWorkerFunctions,
} from "./channexManagementWorkerBoundary.js";
import { createPgChannexAriSchedule } from "./pmsChannexAriSchedule.js";
import { createPgPmsChannexManagementWorkerStore } from "./pmsChannexManagementWorkerStore.js";
import { createPmsChannexManagementTargetState } from "./pmsChannexManagementTargetState.js";
import { prepareChannexReceiptPersistence } from "../domains/channexCreationReceiptStore.js";
import type { ChannexManagementJob } from "./pmsChannexManagementWorker.js";

const url = process.env["TEST_DATABASE_URL"];
if (url && !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname))
  throw new Error("Test database required");
const property = randomUUID(),
  other = randomUUID(),
  room = randomUUID(),
  connection = randomUUID(),
  jobId = randomUUID(),
  mapping = randomUUID();
const externalProperty = randomUUID(),
  externalRoom = randomUUID(),
  externalRate = randomUUID();
const key = randomUUID(),
  workerId = "permission-fixture";

describe.skipIf(!url)("Channex worker effective permissions", () => {
  const owner = new pg.Client({ connectionString: url });
  let pool: pg.Pool, store: ReturnType<typeof createPgPmsChannexManagementWorkerStore>;
  let createdRole = false,
    job: ChannexManagementJob,
    target: string,
    intent: string,
    creation: string,
    jobAttempt: string,
    receipt: string;
  beforeAll(async () => {
    await owner.connect();
    await owner.query(
      `CREATE ROLE ${role} LOGIN PASSWORD 'fixture' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    createdRole = true;
    const database = (
      await owner.query("SELECT current_database() AS name")
    ).rows[0].name.replaceAll('"', '""');
    await owner.query(
      `REVOKE TEMP ON DATABASE "${database}" FROM PUBLIC; GRANT CONNECT ON DATABASE "${database}" TO ${role}`,
    );
    for (const functionName of channexManagementWorkerFunctions)
      await owner.query(
        `REVOKE EXECUTE ON FUNCTION ${functionName} FROM PUBLIC; GRANT EXECUTE ON FUNCTION ${functionName} TO ${role}`,
      );
    await assertChannexManagementWorkerBoundary(owner, { allowMissingGrants: true });
    await owner.query(
      `GRANT USAGE ON SCHEMA platform,pms,identity,hotel_catalog,booking,finance TO ${role}`,
    );
    for (const [table, grants] of Object.entries(privileges))
      for (const [kind, columns] of Object.entries(grants))
        await owner.query(
          `GRANT ${kind}${columns === true ? "" : `(${columns.join(",")})`} ON ${table} TO ${role}`,
        );
    const login = new URL(url!);
    login.username = role;
    login.password = "fixture";
    pool = new pg.Pool({ connectionString: login.toString() });
    store = createPgPmsChannexManagementWorkerStore({
      connectionString: login.toString(),
      targetState: createPmsChannexManagementTargetState(),
      stagingRestrictionsPropertyId: property,
      stagingPublishedOffersEnabled: true,
      stagingInventoryEnabled: true,
    });
    await owner.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Allowed'),($2::uuid,$2::text,'Denied')",
      [property, other],
    );
    await owner.query("INSERT INTO platform.channex_management_worker_properties VALUES($1)", [
      property,
    ]);
    await owner.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Room')", [
      room,
      property,
    ]);
    await owner.query(
      "INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1,'channex',$2,'active','enable')",
      [property, externalProperty],
    );
    await owner.query(
      "INSERT INTO pms.channel_connections(id,property_id,provider,connection_status,external_property_id) VALUES($1,$2,'channex','connected',$3)",
      [connection, property, externalProperty],
    );
    await owner.query(
      "INSERT INTO pms.channel_room_type_mappings(id,property_id,connection_id,room_type_id,external_room_type_id) VALUES($1,$2,$3,$4,$5)",
      [mapping, property, connection, room, externalRoom],
    );
    await owner.query(
      `INSERT INTO platform.jobs(id,job_key,queue_name,job_type,tenant_scope,property_id,resource_product,resource_type,resource_id,payload,idempotency_key_hash)
      VALUES($1::uuid,$1::text,'pms.channex.management','channex.provision','property',$2::uuid,'pms','channex_connection',$2::text,$3,$4)`,
      [
        jobId,
        property,
        JSON.stringify({
          operationType: "provision",
          publishedOffer: {
            roomTypeId: room,
            offerId: "offer",
            publicationRevision: 1,
            primaryOccupancy: 1,
          },
          commandId: randomUUID(),
          idempotencyKey: key,
        }),
        createHash("sha256").update(key).digest("hex"),
      ],
    );
  });
  afterAll(async () => {
    await store?.close?.();
    await pool?.end();
    if (createdRole) {
      await owner.query(
        "DELETE FROM platform.channex_management_worker_properties WHERE property_id=$1",
        [property],
      );
      await owner.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    }
    // Other integration fixtures exercise the migration-default path before the
    // platform grant runner replaces PUBLIC execution with the dedicated role.
    for (const functionName of channexManagementWorkerFunctions)
      await owner.query(`GRANT EXECUTE ON FUNCTION ${functionName} TO PUBLIC`);
    // Immutable synthetic attempts/receipts stay until the disposable DB is dropped.
    await owner.end();
  });
  async function denied(sql: string, values: unknown[] = []) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(client.query(sql, values)).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
  it("attests effective privileges and reads every declared source with the exact login", async () => {
    const client = await pool.connect();
    try {
      expect((await client.query("SELECT current_user,session_user")).rows[0]).toEqual({
        current_user: role,
        session_user: role,
      });
      await assertChannexManagementWorkerBoundary(client, { propertyId: property });
      const startup = {
        workerEnabled: true,
        workerDatabaseUrl: pool.options.connectionString,
        apiBaseUrl: "https://staging.channex.io",
        stagingRestrictionsPropertyId: property,
        bookingMutationOwner: "legacy" as const,
        capabilityModes: {
          connection: "observe_only",
          provisioning: "observe_only",
          ariSync: "mutating",
          bookingSync: "observe_only",
          markups: "observe_only",
          messaging: "observe_only",
          reviews: "observe_only",
          iframe: "observe_only",
        } as const,
      };
      await preflightChannexManagementWorker(startup, true);
      await expect(
        preflightChannexManagementWorker({ ...startup, workerDatabaseUrl: url }, true),
      ).rejects.toThrow("channex_worker_login_mismatch");
      for (const [table, grants] of Object.entries(privileges))
        await client.query(
          `SELECT ${grants.SELECT === true ? "*" : (grants.SELECT as string[]).join(",")} FROM ${table} LIMIT 1`,
        );
      for (const view of [
        "booking.pricing_runtime_effective_property_scopes",
        "booking.pricing_runtime_effective_authority_scopes",
      ]) expect((await client.query(`SELECT * FROM ${view}`)).rows).toEqual([]);
      expect((await client.query("SELECT id FROM hotel_catalog.properties")).rows).toEqual([
        { id: property },
      ]);
    } finally {
      client.release();
    }
  });
  it("claims a selected offer, persists its original response, and preserves continuation", async () => {
    const claimed = await store.claim({ workerId, now: new Date() });
    expect(claimed?.jobId).toBe(jobId);
    job = claimed!;
    jobAttempt = (await pool.query("SELECT id FROM platform.job_attempts WHERE job_id=$1", [jobId]))
      .rows[0].id;
    target = (
      await pool.query(
        "INSERT INTO pms.channex_offer_targets(property_id,connection_id,room_type_id,offer_id) VALUES($1,$2,$3,'offer') RETURNING id",
        [property, connection, room],
      )
    ).rows[0].id;
    const reserved = (
      await pool.query(
        "INSERT INTO pms.channex_offer_target_intents(target_id,operation_key,proposal) VALUES($1,$2,'{\"fixture\":true}') RETURNING id,version",
        [target, key],
      )
    ).rows[0];
    intent = reserved.id;
    creation = (
      await pool.query(
        `INSERT INTO pms.channex_offer_create_attempts(target_id,intent_id,version,binding_generation,external_property_id,external_room_type_id,request_body,job_attempt_id,worker_id)
      SELECT $1,$2,$3,binding_generation,$4,$5,'{"fixture":true}',$6,$7 FROM pms.channel_connections WHERE id=$8 RETURNING id`,
        [
          target,
          intent,
          reserved.version,
          externalProperty,
          externalRoom,
          jobAttempt,
          workerId,
          connection,
        ],
      )
    ).rows[0].id;
    receipt = randomUUID();
    const persist = await prepareChannexReceiptPersistence(
      pool,
      {
        receiptId: receipt,
        attemptId: creation,
        jobAttemptId: jobAttempt,
        workerId,
        propertyId: property,
        connectionId: connection,
      },
      new Response(
        JSON.stringify({
          data: {
            id: externalRate,
            type: "rate_plan",
            attributes: { property_id: externalProperty, room_type_id: externalRoom },
          },
        }),
        { status: 201 },
      ),
    );
    expect(await persist()).toEqual({ kind: "retained", receiptId: receipt });
    expect(await persist()).toEqual({ kind: "retained", receiptId: receipt });
    await store.continueUpload(
      job,
      { ok: false, code: "offer_creation_retained", attemptId: creation },
      { workerId, now: new Date() },
    );
    expect(
      (await pool.query("SELECT status,max_attempts FROM platform.jobs WHERE id=$1", [jobId]))
        .rows[0],
    ).toEqual({ status: "pending", max_attempts: 6 });
    // Claim SQL uses database time; let the fixture owner make the continuation due.
    await owner.query("UPDATE platform.jobs SET run_after=now() WHERE id=$1", [jobId]);
    job = (await store.claim({ workerId, now: new Date() }))!;
    expect(job.jobId).toBe(jobId);
  });
  it("retains ARI receipts, claims external ownership and seals a target without source writes", async () => {
    await pool.query(
      "UPDATE pms.channex_offer_create_attempts SET state='identified',external_rate_plan_id=$2 WHERE id=$1",
      [creation, externalRate],
    );
    jobAttempt = (
      await pool.query(
        "SELECT id FROM platform.job_attempts WHERE job_id=$1 AND attempt_number=$2",
        [jobId, job.attemptNumber],
      )
    ).rows[0].id;
    const ari = (
      await pool.query(
        "INSERT INTO pms.channex_offer_ari_attempts(creation_attempt_id,job_attempt_id,worker_id,service_date,request_body) VALUES($1,$2,$3,current_date,'{\"fixture\":true}') RETURNING id",
        [creation, jobAttempt, workerId],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO pms.channex_offer_ari_receipts(id,attempt_id,job_attempt_id,worker_id,outcome,http_status,task_ids,has_warnings) VALUES($1,$2,$3,$4,'complete_json',200,$5,false)",
      [randomUUID(), ari, jobAttempt, workerId, [randomUUID()]],
    );
    await pool.query(
      "UPDATE pms.channex_offer_ari_attempts SET state='reconciled',reconciliation_evidence='{\"fixture\":true}' WHERE id=$1",
      [ari],
    );
    await pool.query(
      `INSERT INTO pms.channex_offer_target_versions(target_id,version,intent_id,binding_generation,external_property_id,external_room_type_id,external_rate_plan_id,configuration,readback_evidence)
      SELECT $1,i.version,i.id,c.binding_generation,$3,$4,$5,'{"fixture":true}','{"fixture":true}' FROM pms.channex_offer_target_intents i CROSS JOIN pms.channel_connections c WHERE i.id=$2 AND c.id=$6`,
      [target, intent, externalProperty, externalRoom, externalRate, connection],
    );
    await pool.query(
      "UPDATE pms.channex_offer_targets SET active_version=(SELECT version FROM pms.channex_offer_target_intents WHERE id=$2) WHERE id=$1",
      [target, intent],
    );
    await store.succeed(job, { ok: true }, { workerId, now: new Date() });
    expect(
      (await pool.query("SELECT status FROM platform.jobs WHERE id=$1", [jobId])).rows[0].status,
    ).toBe("succeeded");
    expect(
      (await pool.query("SELECT owner_kind FROM pms.channex_external_rate_owners")).rows,
    ).toEqual([{ owner_kind: "offer" }]);
  });
  it("scans sources, renews the lease, retries and dead-letters only its scoped job", async () => {
    const scheduler = createPgChannexAriSchedule(pool.options.connectionString!, property);
    try {
      expect(await scheduler.enqueue()).toBe(1);
      expect(await scheduler.enqueue()).toBe(0);
      const scheduled = (await store.claim({ workerId, now: new Date() }))!;
      expect(scheduled.input.operationType).toBe("sync_ari");
      const failure = { ok: false as const, code: "provider_rejected" as const, message: "Synthetic failure" };
      expect(
        await store.fail(scheduled, failure, {
          workerId,
          now: new Date(),
          retryable: true,
          retryAt: new Date(),
        }),
      ).toBe("retry_scheduled");
      const retry = (await store.claim({ workerId, now: new Date() }))!;
      expect(retry.jobId).toBe(scheduled.jobId);
      expect(
        await store.fail(retry, failure, {
          workerId,
          now: new Date(),
          retryable: false,
          retryAt: null,
        }),
      ).toBe("dead_lettered");
      expect((await pool.query("SELECT job_id FROM platform.dead_letter_events")).rows).toEqual([
        { job_id: scheduled.jobId },
      ]);
    } finally {
      await scheduler.close();
    }
  });
  it("denies source edits, credential widening, receipts and unrelated products", async () => {
    for (const sql of [
      "UPDATE hotel_catalog.properties SET id=id",
      "UPDATE pms.room_types SET id=id",
      "UPDATE pms.channel_binding_claims SET id=id",
      "UPDATE pms.channel_room_type_mappings SET id=id",
      "UPDATE pms.channel_connections SET external_property_id='changed'",
      "UPDATE platform.jobs SET idempotency_key_hash=repeat('b',64)",
      "UPDATE pms.channex_offer_create_receipts SET http_status=500",
      "DELETE FROM pms.channex_offer_create_receipts",
      "UPDATE finance.payment_settings SET payments_enabled=true",
      "UPDATE booking.guest_bookings SET updated_at=now()",
      "INSERT INTO platform.channex_management_worker_properties VALUES(gen_random_uuid())",
    ])
      await denied(sql);
    await denied(
      "INSERT INTO pms.channex_offer_targets(property_id,connection_id,room_type_id,offer_id) VALUES($1,$2,$3,'other')",
      [other, connection, room],
    );
    for (const sql of [
      `ALTER ROLE ${role} SET session_replication_role=replica`,
      `REVOKE EXECUTE ON FUNCTION platform.channex_management_worker_scope(text,text,uuid) FROM ${role}`,
      `GRANT SET ON PARAMETER session_replication_role TO ${role}`,
      `GRANT UPDATE(idempotency_key_hash) ON platform.jobs TO ${role}`,
      `ALTER TABLE pms.channex_offer_targets DISABLE ROW LEVEL SECURITY`,
      `ALTER TABLE pms.channel_connections DISABLE TRIGGER channex_worker_connection_update`,
      `ALTER VIEW finance.online_card_readiness SET(security_invoker=false)`,
    ]) {
      await owner.query("BEGIN");
      try {
        await owner.query(sql);
        await expect(assertChannexManagementWorkerBoundary(owner)).rejects.toThrow(
          "channex_worker_",
        );
      } finally {
        await owner.query("ROLLBACK");
      }
    }
  });
});
