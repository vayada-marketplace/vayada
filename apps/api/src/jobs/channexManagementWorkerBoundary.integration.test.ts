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
import { createPgChannexManagementPlanPort } from "../integrations/channexManagementPlans.js";
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
      expect(
        (await client.query("SELECT * FROM booking.pricing_runtime_effective_property_scopes"))
          .rows,
      ).toEqual([]);
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
      const failure = {
        ok: false as const,
        code: "provider_rejected" as const,
        message: "Synthetic failure",
      };
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
      `ALTER TABLE identity.product_entitlements DISABLE TRIGGER entitlement_routing_organization_lock`,
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
  // VAY-2055: production scope. Admission is the operation plus a live enable
  // job for an unbound hotel; nothing is keyed on the property allowlist.
  it("runs only unbound enable jobs in the connection-only scope", async () => {
    const fresh = randomUUID(),
      freshEnable = randomUUID(),
      freshAri = randomUUID(),
      boundEnable = randomUUID(),
      freshExternal = randomUUID(),
      freshKey = randomUUID();
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    // Earlier interrupted local runs may leave live enable jobs behind; they would
    // widen the connection scope. A fresh CI database has none.
    await owner.query(
      "UPDATE platform.jobs SET status='canceled',finished_at=now(),locked_at=NULL,locked_by=NULL WHERE queue_name='pms.channex.management' AND job_type='channex.enable' AND status IN ('pending','running')",
    );
    await owner.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Fresh hotel')",
      [fresh],
    );
    await owner.query(
      "INSERT INTO hotel_catalog.property_locations(property_id,country_code,city,timezone) VALUES($1,'DE','Berlin','Europe/Berlin')",
      [fresh],
    );
    await owner.query(
      "INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Fresh room'),($3,$4,'Denied room')",
      [randomUUID(), fresh, randomUUID(), other],
    );
    const insert = `INSERT INTO platform.jobs(id,job_key,queue_name,job_type,tenant_scope,property_id,resource_product,resource_type,resource_id,payload,idempotency_key_hash)
      VALUES($1::uuid,$1::text,'pms.channex.management',$3,'property',$2::uuid,'pms','channex_connection',$2::text,$4,$5)`;
    for (const [id, propertyId, type, idempotencyKey] of [
      [freshEnable, fresh, "enable", freshKey],
      [freshAri, fresh, "sync_ari", randomUUID()],
      [boundEnable, property, "enable", randomUUID()],
    ] as const)
      await owner.query(insert, [
        id,
        propertyId,
        `channex.${type}`,
        JSON.stringify({ operationType: type, commandId: randomUUID(), idempotencyKey }),
        hash(idempotencyKey),
      ]);
    await owner.query(
      `INSERT INTO platform.idempotency_keys(operation_scope,operation,key_hash,request_fingerprint_hash,tenant_scope,property_id,expires_at)
      VALUES('pms','channex_management',$1,repeat('b',64),'property',$2,'infinity')`,
      [hash(freshKey), fresh],
    );
    const login = pool.options.connectionString!;
    const connection = createPgPmsChannexManagementWorkerStore({
      connectionString: login,
      targetState: createPmsChannexManagementTargetState(),
      ariSyncMutating: false,
      connectionOnly: true,
    });
    const plans = createPgChannexManagementPlanPort({
      connectionString: login,
      bookingRevisionHandoff: async () => {},
    });
    const production = {
      workerEnabled: true,
      workerDatabaseUrl: login,
      apiBaseUrl: "https://app.channex.io",
      bookingMutationOwner: "legacy" as const,
      capabilityModes: {
        connection: "mutating",
        provisioning: "observe_only",
        ariSync: "observe_only",
        bookingSync: "observe_only",
        markups: "observe_only",
        messaging: "observe_only",
        reviews: "mutating",
        iframe: "observe_only",
      } as const,
    };
    const jobStatus = async (id: string) =>
      (await owner.query("SELECT status FROM platform.jobs WHERE id=$1", [id])).rows[0].status;
    try {
      await expect(preflightChannexManagementWorker(production, true)).rejects.toThrow(
        "channex_worker_operation_scope_mismatch",
      );
      expect(await connection.claim({ workerId, now: new Date() })).toBeNull();
      await owner.query(
        "INSERT INTO platform.channex_management_worker_operations VALUES('enable')",
      );
      await preflightChannexManagementWorker(production, true);
      await assertChannexManagementWorkerBoundary(owner, { propertyId: property });
      const claimed = (await connection.claim({ workerId, now: new Date() }))!;
      expect(claimed.jobId).toBe(freshEnable);
      expect(await connection.claim({ workerId, now: new Date() })).toBeNull();
      const plan = await plans.plan(claimed);
      expect(plan.requests.map((request) => [request.method, request.path])).toEqual([
        ["GET", "/api/v1/properties"],
        ["POST", "/api/v1/properties"],
      ]);
      expect(plan.requests[1]?.body).toMatchObject({
        property: { title: `Fresh hotel [Vayada:${fresh}]`, currency: "EUR", city: "Berlin" },
      });
      const created = {
        ok: true as const,
        externalPropertyId: freshExternal,
        connectionStatus: "connected" as const,
        createdProperty: { environment: "production" as const, externalPropertyId: freshExternal },
        roomTypeMappings: [],
        ratePlanMappings: [],
      };
      await plan.checkpoint!(created);
      expect(
        (
          await pool.query(
            "SELECT id FROM hotel_catalog.properties WHERE id=ANY($1::uuid[]) ORDER BY id",
            [[property, fresh, other]],
          )
        ).rows,
      ).toEqual([{ id: property }, { id: fresh }].sort((a, b) => a.id.localeCompare(b.id)));
      expect(
        (await pool.query("SELECT id FROM pms.room_types WHERE property_id=$1", [other])).rows,
      ).toEqual([]);
      for (const [sql, values] of [
        [
          "UPDATE pms.channel_connections SET external_property_id=$1 WHERE property_id=$2",
          [randomUUID(), fresh],
        ],
        [
          "UPDATE pms.channel_connections SET connection_metadata='{}' WHERE property_id=$1",
          [fresh],
        ],
        [
          "UPDATE pms.channel_connections SET connection_status='disconnected' WHERE property_id=$1",
          [fresh],
        ],
        [
          "UPDATE pms.channel_binding_claims SET claim_state='released' WHERE property_id=$1",
          [fresh],
        ],
        [
          "INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1,'channex',$2,'active','enable')",
          [other, randomUUID()],
        ],
        [
          "INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1,'channex',$2,'historical','enable')",
          [fresh, randomUUID()],
        ],
        ["INSERT INTO platform.channex_management_worker_operations VALUES('enable')", []],
        [
          `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
           VALUES($1,'pms.channex.management','channex.enable','property',$2::uuid,'pms','channex_connection',$2::text,'{"operationType":"enable"}')`,
          [randomUUID(), other],
        ],
      ] as const)
        await denied(sql, [...values]);
      // The binding-claim trigger rejects an unclaimed connection before RLS does.
      await expect(
        pool.query(
          "INSERT INTO pms.channel_connections(property_id,provider,connection_status,external_property_id) VALUES($1,'channex','connected',$2)",
          [other, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^(23514|42501)$/) });
      await connection.succeed(claimed, created, { workerId, now: new Date() });
      expect(
        (
          await owner.query(
            `SELECT c.connection_status,c.external_property_id,c.connection_metadata->'airbnbCreationEvidence' AS evidence,b.claim_source,b.claim_state
             FROM pms.channel_connections c JOIN pms.channel_binding_claims b ON b.property_id=c.property_id AND b.provider=c.provider
             WHERE c.property_id=$1`,
            [fresh],
          )
        ).rows,
      ).toEqual([
        {
          connection_status: "connected",
          external_property_id: freshExternal,
          claim_source: "enable",
          claim_state: "active",
          evidence: {
            contractVersion: "channex-property-creation.v1",
            environment: "production",
            externalPropertyId: freshExternal,
            jobId: freshEnable,
          },
        },
      ]);
      expect(await jobStatus(freshEnable)).toBe("succeeded");
      expect(
        (
          await owner.query("SELECT status FROM platform.idempotency_keys WHERE key_hash=$1", [
            hash(freshKey),
          ])
        ).rows,
      ).toEqual([{ status: "completed" }]);
      expect(
        (
          await owner.query("SELECT action FROM platform.product_audit_events WHERE job_id=$1", [
            freshEnable,
          ])
        ).rows,
      ).toEqual([{ action: "pms.channex.enable.succeeded" }]);
      // The bound hotel left the scope; its queued ARI job and the already
      // bound hotel's enable job are never claimed.
      expect(
        (
          await pool.query("SELECT id FROM hotel_catalog.properties WHERE id=ANY($1::uuid[])", [
            [property, fresh, other],
          ])
        ).rows,
      ).toEqual([{ id: property }]);
      expect(await connection.claim({ workerId, now: new Date() })).toBeNull();
      expect(await jobStatus(freshAri)).toBe("pending");
      expect(await jobStatus(boundEnable)).toBe("pending");
      // A hotel with a stale disconnected row binds through the guarded UPDATE
      // path, its own interrupted attempt may be re-claimed, a foreign binding
      // with an expired lease never is.
      const second = randomUUID(),
        secondEnable = randomUUID(),
        secondExternal = randomUUID(),
        secondKey = randomUUID();
      await owner.query(
        "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Second hotel')",
        [second],
      );
      await owner.query(
        "INSERT INTO pms.channel_connections(property_id,provider,connection_status) VALUES($1,'channex','disconnected')",
        [second],
      );
      await owner.query(insert, [
        secondEnable,
        second,
        "channex.enable",
        JSON.stringify({
          operationType: "enable",
          commandId: randomUUID(),
          idempotencyKey: secondKey,
        }),
        hash(secondKey),
      ]);
      await owner.query(
        "UPDATE platform.jobs SET status='running',attempts_count=1,locked_by='stale',locked_at=now()-interval '1 hour' WHERE id=$1",
        [boundEnable],
      );
      const first = (await connection.claim({ workerId, now: new Date() }))!;
      expect(first.jobId).toBe(secondEnable);
      const secondCreated = { ...created, externalPropertyId: secondExternal };
      secondCreated.createdProperty = {
        environment: "production",
        externalPropertyId: secondExternal,
      };
      await (
        await plans.plan(first)
      ).checkpoint!(secondCreated);
      await owner.query("UPDATE platform.jobs SET locked_at=now()-interval '1 hour' WHERE id=$1", [
        secondEnable,
      ]);
      const resumed = (await connection.claim({ workerId, now: new Date() }))!;
      expect(resumed).toMatchObject({ jobId: secondEnable, attemptNumber: 2 });
      await connection.succeed(resumed, secondCreated, { workerId, now: new Date() });
      expect(
        (
          await owner.query(
            "SELECT connection_status,external_property_id,connection_metadata->'airbnbCreationEvidence'->>'jobId' AS job FROM pms.channel_connections WHERE property_id=$1",
            [second],
          )
        ).rows,
      ).toEqual([
        { connection_status: "connected", external_property_id: secondExternal, job: secondEnable },
      ]);
      expect(await jobStatus(secondEnable)).toBe("succeeded");
      expect(await jobStatus(boundEnable)).toBe("running");
      expect(await connection.claim({ workerId, now: new Date() })).toBeNull();
    } finally {
      await plans.close();
      await connection.close?.();
      await owner.query("DELETE FROM platform.channex_management_worker_operations");
    }
  });
  it("sees only claimed, connected hotels in the VAY-2108 claimed scope", async () => {
    const claimed = randomUUID(),
      unclaimed = randomUUID(),
      claimedJob = randomUUID(),
      unclaimedJob = randomUUID(),
      claimedExternal = randomUUID(),
      unclaimedExternal = randomUUID();
    const ids = [claimed, unclaimed];
    await owner.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Claimed'),($2::uuid,$2::text,'Unclaimed')",
      ids,
    );
    await owner.query(
      "INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source) VALUES($1,'channex',$2,'active','repair'),($3,'channex',$4,'active','repair')",
      [claimed, claimedExternal, unclaimed, unclaimedExternal],
    );
    await owner.query(
      "INSERT INTO pms.channel_connections(property_id,provider,connection_status,external_property_id) VALUES($1,'channex','connected',$2),($3,'channex','connected',$4)",
      [claimed, claimedExternal, unclaimed, unclaimedExternal],
    );
    // The other hotel's claim leaves 'active', as a revoke would, while its connection stays.
    await owner.query(
      "UPDATE pms.channel_binding_claims SET claim_state='released' WHERE property_id=$1",
      [unclaimed],
    );
    for (const [id, propertyId] of [
      [claimedJob, claimed],
      [unclaimedJob, unclaimed],
    ])
      await owner.query(
        `INSERT INTO platform.jobs(id,job_key,queue_name,job_type,tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
        VALUES($1::uuid,$1::text,'pms.channex.management','channex.sync_ari','property',$2::uuid,'pms','channex_connection',$2::text,$3)`,
        [
          id,
          propertyId,
          JSON.stringify({
            operationType: "sync_ari",
            commandId: randomUUID(),
            idempotencyKey: id,
          }),
        ],
      );
    const rows = async (sql: string, values: unknown[]) =>
      (await pool.query<{ id: string }>(sql, values)).rows.map((row) => row.id);
    const jobs = () =>
      rows("SELECT id::text FROM platform.jobs WHERE id = ANY($1::uuid[])", [
        [claimedJob, unclaimedJob],
      ]);
    const claimedTable = "platform.channex_management_worker_claimed_operations";
    try {
      // Before the claimed grant the worker cannot read the owner table: its scans still work and
      // nothing claimed is visible, even with operations admitted.
      await owner.query(`REVOKE SELECT ON ${claimedTable} FROM ${role}`);
      await owner.query(`INSERT INTO ${claimedTable} VALUES('sync_ari'),('provision')`);
      expect(await jobs()).toEqual([]);
      expect(
        await rows(
          "SELECT property_id::text AS id FROM pms.channel_connections WHERE property_id = ANY($1::uuid[])",
          [ids],
        ),
      ).toEqual([]);
      await owner.query(`DELETE FROM ${claimedTable}`);
      await owner.query(`GRANT SELECT ON ${claimedTable} TO ${role}`);
      // Nothing is admitted until the owner adds the claimed operations.
      expect(await jobs()).toEqual([]);
      expect(
        await rows("SELECT id::text FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
          ids,
        ]),
      ).toEqual([]);
      await denied(
        "INSERT INTO platform.channex_management_worker_claimed_operations VALUES('sync_ari')",
      );
      await owner.query(
        "INSERT INTO platform.channex_management_worker_claimed_operations VALUES('sync_ari'),('provision')",
      );
      const client = await pool.connect();
      try {
        await assertChannexManagementWorkerBoundary(client, {
          propertyId: property,
          claimedScope: true,
        });
      } finally {
        client.release();
      }
      expect(await jobs()).toEqual([claimedJob]);
      expect(
        await rows("SELECT id::text FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
          ids,
        ]),
      ).toEqual([claimed]);
      expect(
        await rows(
          "SELECT property_id::text AS id FROM pms.channel_connections WHERE property_id = ANY($1::uuid[])",
          [ids],
        ),
      ).toEqual([claimed]);
    } finally {
      await owner.query(`DELETE FROM ${claimedTable}`);
      await owner.query(`GRANT SELECT ON ${claimedTable} TO ${role}`);
    }
  });
});
