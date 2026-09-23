import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("Channex room availability attempt storage", () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());

  async function fixture() {
    assertSafeTestDatabase(url!);
    const propertyId = randomUUID(),
      connectionId = randomUUID(),
      roomTypeId = randomUUID(),
      mappingId = randomUUID(),
      externalPropertyId = randomUUID(),
      externalRoomTypeId = randomUUID(),
      jobId = randomUUID(),
      jobAttemptId = randomUUID(),
      workerId = `availability-${randomUUID()}`;
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Availability test')",
      [propertyId],
    );
    await pool.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Room')", [
      roomTypeId,
      propertyId,
    ]);
    await pool.query(
      `INSERT INTO pms.channel_binding_claims
         (property_id,provider,external_property_id,claim_state,claim_source)
       VALUES($1,'channex',$2,'active','enable')`,
      [propertyId, externalPropertyId],
    );
    await pool.query(
      `INSERT INTO pms.channel_connections
         (id,property_id,provider,connection_status,external_property_id)
       VALUES($1,$2,'channex','connected',$3)`,
      [connectionId, propertyId, externalPropertyId],
    );
    const bindingGeneration = (
      await pool.query("SELECT binding_generation FROM pms.channel_connections WHERE id=$1", [
        connectionId,
      ])
    ).rows[0].binding_generation as string;
    await pool.query(
      `INSERT INTO pms.channel_room_type_mappings
         (id,property_id,connection_id,room_type_id,external_room_type_id)
       VALUES($1,$2,$3,$4,$5)`,
      [mappingId, propertyId, connectionId, roomTypeId, externalRoomTypeId],
    );
    await pool.query(
      `INSERT INTO platform.jobs
         (id,job_key,queue_name,job_type,status,attempts_count,locked_by,locked_at,
          tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
       VALUES($1::uuid,$1::text,'pms.channex.management','channex.sync_ari','running',
         1,$3,clock_timestamp(),'property',$2::uuid,'pms','channex_connection',$2::uuid::text,
         '{"operationType":"sync_ari"}')`,
      [jobId, propertyId, workerId],
    );
    await pool.query(
      `INSERT INTO platform.job_attempts(id,job_id,attempt_number,worker_id)
       VALUES($1,$2,1,$3)`,
      [jobAttemptId, jobId, workerId],
    );
    const insert = (
      client: Pick<pg.Pool, "query"> | pg.PoolClient = pool,
      values: Partial<{
        mappingId: string;
        jobAttemptId: string;
        workerId: string;
        date: string;
        availableCount: number;
        inventoryEvidence: unknown;
        requestBody: unknown;
        digest: string | null;
      }> = {},
    ) =>
      client.query(
        `INSERT INTO pms.channex_room_availability_attempts
           (property_id,connection_id,mapping_id,room_type_id,binding_generation,
            external_property_id,external_room_type_id,job_attempt_id,worker_id,
            service_date,available_count,inventory_evidence,request_body,inventory_evidence_sha256)
         VALUES(gen_random_uuid(),gen_random_uuid(),$1,gen_random_uuid(),gen_random_uuid(),
           'caller-property','caller-room',$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
         RETURNING *`,
        [
          values.mappingId ?? mappingId,
          values.jobAttemptId ?? jobAttemptId,
          values.workerId ?? workerId,
          values.date ?? "2030-06-14",
          values.availableCount ?? 2,
          JSON.stringify(values.inventoryEvidence ?? { materializedRevision: 7 }),
          JSON.stringify(
            values.requestBody ?? {
              values: [
                {
                  property_id: externalPropertyId,
                  room_type_id: externalRoomTypeId,
                  date: "2030-06-14",
                  availability: 2,
                },
              ],
            },
          ),
          values.digest === undefined ? "0".repeat(64) : values.digest,
        ],
      );
    return {
      propertyId,
      connectionId,
      roomTypeId,
      mappingId,
      externalPropertyId,
      externalRoomTypeId,
      bindingGeneration,
      jobId,
      jobAttemptId,
      workerId,
      insert,
    };
  }

  it("derives provider identity and retains immutable history", async () => {
    const f = await fixture(),
      attempt = (await f.insert()).rows[0];
    expect(attempt).toMatchObject({
      property_id: f.propertyId,
      connection_id: f.connectionId,
      mapping_id: f.mappingId,
      room_type_id: f.roomTypeId,
      binding_generation: f.bindingGeneration,
      external_property_id: f.externalPropertyId,
      external_room_type_id: f.externalRoomTypeId,
      job_attempt_id: f.jobAttemptId,
      worker_id: f.workerId,
      available_count: 2,
      inventory_evidence_sha256: "0".repeat(64),
      state: "unresolved",
      reconciliation_evidence: {},
    });
    for (const assignment of [
      "available_count=3",
      "request_body='{}'",
      "inventory_evidence='{}'",
      `inventory_evidence_sha256='${"f".repeat(64)}'`,
      "service_date='2030-06-15'",
      "mapping_id=gen_random_uuid()",
      "external_room_type_id='changed'",
      "created_at='2000-01-01'",
    ])
      await expect(
        pool.query(`UPDATE pms.channex_room_availability_attempts SET ${assignment} WHERE id=$1`, [
          attempt.id,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM pms.channex_room_availability_attempts WHERE id=$1", [attempt.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "UPDATE pms.channex_room_availability_attempts SET state='reconciled' WHERE id=$1",
        [attempt.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      `UPDATE pms.channex_room_availability_attempts
       SET state='reconciled',reconciliation_evidence='{"verified":true}' WHERE id=$1`,
      [attempt.id],
    );
    await expect(
      pool.query(
        `UPDATE pms.channex_room_availability_attempts
         SET reconciliation_evidence='{"changed":true}' WHERE id=$1`,
        [attempt.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const unsent = (await f.insert()).rows[0];
    await pool.query(
      `UPDATE pms.channex_room_availability_attempts
       SET state='not_sent',reconciliation_evidence=
         '{"schemaVersion":1,"reason":"pre_dispatch_verification_unavailable"}'::jsonb
       WHERE id=$1`,
      [unsent.id],
    );
    await expect(
      pool.query(
        `UPDATE pms.channex_room_availability_attempts
         SET reconciliation_evidence='{"schemaVersion":1,"reason":"changed"}' WHERE id=$1`,
        [unsent.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("requires claim-time evidence digest before an attempt can exist", async () => {
    const f = await fixture();
    await expect(f.insert(pool, { digest: null })).rejects.toMatchObject({ code: "23502" });
  });

  it("retains one immutable original dispatch receipt", async () => {
    const f = await fixture(),
      attempt = (await f.insert()).rows[0],
      receiptId = randomUUID(),
      taskId = randomUUID();
    const receipt = (
      await pool.query(
        `INSERT INTO pms.channex_room_availability_receipts
           (id,attempt_id,job_attempt_id,worker_id,outcome,http_status,
            provider_request_id,task_ids,has_warnings,warning_reason,captured_at)
         VALUES($1,$2,$3,$4,'complete_json',200,'request.1',$5::uuid[],false,NULL,'2000-01-01')
         RETURNING *`,
        [receiptId, attempt.id, f.jobAttemptId, f.workerId, [taskId]],
      )
    ).rows[0];
    expect(receipt).toMatchObject({
      id: receiptId,
      attempt_id: attempt.id,
      job_attempt_id: f.jobAttemptId,
      worker_id: f.workerId,
      outcome: "complete_json",
      http_status: 200,
      provider_request_id: "request.1",
      task_ids: [taskId],
      has_warnings: false,
      warning_reason: null,
    });
    expect(new Date(receipt.captured_at).getUTCFullYear()).not.toBe(2000);
    await expect(
      pool.query(
        `INSERT INTO pms.channex_room_availability_receipts
           (id,attempt_id,job_attempt_id,worker_id,outcome,http_status,task_ids,has_warnings)
         VALUES(gen_random_uuid(),$1,$2,$3,'invalid_json',502,'{}',true)`,
        [attempt.id, f.jobAttemptId, f.workerId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query("UPDATE pms.channex_room_availability_receipts SET http_status=201 WHERE id=$1", [
        receiptId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM pms.channex_room_availability_receipts WHERE id=$1", [receiptId]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("requires exact attempt correlation and bounded receipt combinations", async () => {
    const f = await fixture(),
      other = await fixture(),
      attempt = (await f.insert()).rows[0];
    const insert = (values: string) =>
      pool.query(
        `INSERT INTO pms.channex_room_availability_receipts
           (id,attempt_id,job_attempt_id,worker_id,outcome,http_status,
            provider_request_id,task_ids,has_warnings,warning_reason)
         VALUES(gen_random_uuid(),$1,$2,$3,${values})`,
        [attempt.id, f.jobAttemptId, f.workerId],
      );
    await expect(
      pool.query(
        `INSERT INTO pms.channex_room_availability_receipts
           (id,attempt_id,job_attempt_id,worker_id,outcome,http_status,task_ids,has_warnings)
         VALUES(gen_random_uuid(),$1,$2,$3,'transport_error',NULL,'{}',true)`,
        [attempt.id, other.jobAttemptId, other.workerId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(insert("'transport_error',500,NULL,'{}',true,NULL")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      insert("'invalid_json',500,NULL,ARRAY[gen_random_uuid()],true,NULL"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insert("'complete_json',200,NULL,'{}',false,'provider_warnings'"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(insert("'complete_json',200,NULL,'{}',false,NULL")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(insert("'complete_json',200,NULL,'{}',true,NULL")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      insert("'complete_json',200,'unsafe request id','{}',true,'invalid_tasks'"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insert("'complete_json',200,NULL,'{}',true,'invalid_tasks'"),
    ).resolves.toMatchObject({ rowCount: 1 });

    const transport = await fixture(),
      transportAttempt = (await transport.insert()).rows[0];
    await expect(
      pool.query(
        `INSERT INTO pms.channex_room_availability_receipts
           (id,attempt_id,job_attempt_id,worker_id,outcome,http_status,task_ids,has_warnings)
         VALUES(gen_random_uuid(),$1,$2,$3,'transport_error',NULL,'{}',true)`,
        [transportAttempt.id, transport.jobAttemptId, transport.workerId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("requires an active mapping and correlated ordinary sync job", async () => {
    const f = await fixture(),
      other = await fixture();
    await expect(
      f.insert(pool, { jobAttemptId: other.jobAttemptId, workerId: other.workerId }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(f.insert(pool, { workerId: "wrong-worker" })).rejects.toMatchObject({
      code: "23514",
    });
    await pool.query(
      `UPDATE platform.jobs SET payload=payload||'{"restrictionsOnly":true}'::jsonb WHERE id=$1`,
      [f.jobId],
    );
    await expect(f.insert()).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      `UPDATE platform.jobs SET payload='{"operationType":"sync_ari"}'::jsonb WHERE id=$1`,
      [f.jobId],
    );
    await pool.query("UPDATE pms.channel_room_type_mappings SET status='disabled' WHERE id=$1", [
      f.mappingId,
    ]);
    await expect(f.insert()).rejects.toMatchObject({ code: "23514" });
  });

  it("requires an exact published-offer room for provision jobs", async () => {
    const f = await fixture();
    await pool.query(
      `UPDATE platform.jobs
       SET job_type='channex.provision',payload=$2::jsonb
       WHERE id=$1`,
      [
        f.jobId,
        JSON.stringify({
          operationType: "provision",
          publishedOffer: {
            roomTypeId: randomUUID(),
            offerId: "offer",
            publicationRevision: 1,
            primaryOccupancy: 1,
          },
        }),
      ],
    );
    await expect(f.insert()).rejects.toMatchObject({ code: "23514" });

    await pool.query(
      `UPDATE platform.jobs
       SET payload=jsonb_set(payload,'{publishedOffer,roomTypeId}',to_jsonb($2::text))
       WHERE id=$1`,
      [f.jobId, f.roomTypeId],
    );
    await expect(f.insert()).resolves.toMatchObject({ rowCount: 1 });
  });

  it.each(["expired", "finished", "superseded", "wrong-scope"])(
    "rejects a %s job attempt",
    async (mode) => {
      const f = await fixture();
      if (mode === "expired")
        await pool.query(
          "UPDATE platform.jobs SET locked_at=now()-interval '6 minutes' WHERE id=$1",
          [f.jobId],
        );
      if (mode === "finished")
        await pool.query(
          "UPDATE platform.job_attempts SET status='succeeded',finished_at=now() WHERE id=$1",
          [f.jobAttemptId],
        );
      if (mode === "superseded")
        await pool.query("UPDATE platform.jobs SET attempts_count=2 WHERE id=$1", [f.jobId]);
      if (mode === "wrong-scope")
        await pool.query("UPDATE platform.jobs SET resource_type='other' WHERE id=$1", [f.jobId]);
      await expect(f.insert()).rejects.toMatchObject({ code: "23514" });
    },
  );

  it("keeps unresolved provider-room exclusion across dates and binding changes", async () => {
    const f = await fixture();
    await f.insert();
    await pool.query(
      "UPDATE pms.channel_connections SET binding_generation=gen_random_uuid() WHERE id=$1",
      [f.connectionId],
    );
    await expect(f.insert(pool, { date: "2030-06-15" })).rejects.toMatchObject({ code: "23505" });
  });

  it("allows another provider room to progress independently", async () => {
    const f = await fixture(),
      roomTypeId = randomUUID(),
      mappingId = randomUUID();
    await pool.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Other room')", [
      roomTypeId,
      f.propertyId,
    ]);
    await pool.query(
      `INSERT INTO pms.channel_room_type_mappings
         (id,property_id,connection_id,room_type_id,external_room_type_id)
       VALUES($1,$2,$3,$4,$5)`,
      [mappingId, f.propertyId, f.connectionId, roomTypeId, randomUUID()],
    );
    await expect(Promise.all([f.insert(), f.insert(pool, { mappingId })])).resolves.toHaveLength(2);
  });

  it("allows only one concurrent unresolved room claim", async () => {
    const f = await fixture(),
      results = await Promise.allSettled([f.insert(), f.insert(pool, { date: "2030-06-15" })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      status: "rejected",
      reason: { code: "23505" },
    });
  });

  it("bounds dates, counts, source evidence, and requests", async () => {
    for (const values of [
      { date: "infinity" },
      { availableCount: -1 },
      { inventoryEvidence: {} },
      { inventoryEvidence: { oversized: "x".repeat(32768) } },
      { requestBody: {} },
      { requestBody: { oversized: "x".repeat(16384) } },
    ]) {
      const f = await fixture();
      await expect(f.insert(pool, values)).rejects.toMatchObject({ code: "23514" });
    }
  });
});
