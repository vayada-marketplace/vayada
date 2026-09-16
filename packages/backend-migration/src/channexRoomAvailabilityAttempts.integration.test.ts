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
      }> = {},
    ) =>
      client.query(
        `INSERT INTO pms.channex_room_availability_attempts
           (property_id,connection_id,mapping_id,room_type_id,binding_generation,
            external_property_id,external_room_type_id,job_attempt_id,worker_id,
            service_date,available_count,inventory_evidence,request_body)
         VALUES(gen_random_uuid(),gen_random_uuid(),$1,gen_random_uuid(),gen_random_uuid(),
           'caller-property','caller-room',$2,$3,$4,$5,$6::jsonb,$7::jsonb)
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
      state: "unresolved",
      reconciliation_evidence: {},
    });
    for (const assignment of [
      "available_count=3",
      "request_body='{}'",
      "inventory_evidence='{}'",
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
