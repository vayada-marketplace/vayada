import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

// VAY-2108 (0481): ongoing offer ARI storage (engineering/channex-ongoing-offer-ari.md).
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("Channex ongoing offer ARI storage", () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());

  async function fixture() {
    assertSafeTestDatabase(url!);
    const property = randomUUID(),
      connection = randomUUID(),
      room = randomUUID(),
      externalProperty = randomUUID(),
      externalRate = randomUUID(),
      worker = "vay-2108-delivery";
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Delivery test')",
      [property],
    );
    await pool.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Room')", [
      room,
      property,
    ]);
    await pool.query(
      `INSERT INTO pms.channel_binding_claims(property_id,provider,external_property_id,claim_state,claim_source)
       VALUES($1,'channex',$2,'active','repair')`,
      [property, externalProperty],
    );
    await pool.query(
      `INSERT INTO pms.channel_connections(id,property_id,provider,connection_status,external_property_id)
       VALUES($1,$2,'channex','connected',$3)`,
      [connection, property, externalProperty],
    );
    const generation = (
      await pool.query("SELECT binding_generation FROM pms.channel_connections WHERE id=$1", [
        connection,
      ])
    ).rows[0].binding_generation as string;
    const target = (
      await pool.query(
        "INSERT INTO pms.channex_offer_targets(property_id,connection_id,room_type_id,offer_id) VALUES($1,$2,$3,'offer') RETURNING id::text",
        [property, connection, room],
      )
    ).rows[0].id as string;
    const intent = (
      await pool.query(
        `INSERT INTO pms.channex_offer_target_intents(target_id,operation_key,proposal)
         VALUES($1,$2,'{"currency":"EUR"}') RETURNING id,version`,
        [target, randomUUID()],
      )
    ).rows[0];
    await pool.query(
      `INSERT INTO pms.channex_offer_target_versions
         (target_id,version,intent_id,binding_generation,external_property_id,external_room_type_id,
          external_rate_plan_id,configuration,readback_evidence)
       VALUES($1,$2,$3,$4,$5,$6,$7,'{"currency":"EUR"}','{"verified":true}')`,
      [target, intent.version, intent.id, generation, externalProperty, room, externalRate],
    );
    // The current lease of a running full ARI job, as the delivery guard requires.
    const job = (
      await pool.query(
        `INSERT INTO platform.jobs(job_key,queue_name,job_type,status,attempts_count,locked_at,locked_by,
           tenant_scope,property_id,resource_product,resource_type,resource_id,payload)
         VALUES($1,'pms.channex.management','channex.sync_ari','running',1,now(),$3,'property',$2,
           'pms','channex_connection',$2::uuid::text,'{"operationType":"sync_ari"}') RETURNING id::text`,
        [`vay-2108-delivery:${property}`, property, worker],
      )
    ).rows[0].id as string;
    const jobAttempt = (
      await pool.query(
        `INSERT INTO platform.job_attempts(job_id,attempt_number,status,worker_id)
         VALUES($1,1,'running',$2) RETURNING id::text`,
        [job, worker],
      )
    ).rows[0].id as string;
    const body = (ratePlan: string = externalRate) =>
      JSON.stringify({
        values: [
          {
            property_id: externalProperty,
            rate_plan_id: ratePlan,
            date_from: "2026-11-01",
            date_to: "2026-11-02",
            stop_sell: true,
          },
        ],
      });
    const deliver = (requestBody = body(), workerId = worker) =>
      pool.query<{ id: string; external: string; version: string }>(
        `INSERT INTO pms.channex_offer_ari_deliveries
           (target_id,version,binding_generation,external_property_id,external_room_type_id,
            external_rate_plan_id,job_attempt_id,worker_id,request_body)
         VALUES($1,99,gen_random_uuid(),'forged','forged','forged',$2,$3,$4::jsonb)
         RETURNING id::text,external_rate_plan_id AS external,version::text`,
        [target, jobAttempt, workerId, requestBody],
      );
    const receipt = (delivery: string) =>
      pool.query(
        `INSERT INTO pms.channex_offer_ari_delivery_receipts
           (id,delivery_id,job_attempt_id,worker_id,outcome,http_status,task_ids,has_warnings)
         VALUES($1,$2,$3,$4,'complete_json',200,ARRAY[gen_random_uuid()],false)`,
        [randomUUID(), delivery, jobAttempt, worker],
      );
    const date = (delivery: string, day: string) =>
      pool.query(
        `INSERT INTO pms.channex_offer_ari_delivery_dates(delivery_id,service_date,value,value_sha256)
         VALUES($1,$2,'{"stop_sell":true}',repeat('a',64))`,
        [delivery, day],
      );
    return { target, job, externalRate, generation, body, deliver, receipt, date };
  }

  it("keeps sales closed by default and records when they open", async () => {
    const f = await fixture();
    const state = async () =>
      (
        await pool.query("SELECT sales_state FROM pms.channex_offer_targets WHERE id=$1", [
          f.target,
        ])
      ).rows[0].sales_state;
    expect(await state()).toBe("closed");
    for (const sql of [
      "UPDATE pms.channex_offer_targets SET sales_state='half' WHERE id=$1",
      "UPDATE pms.channex_offer_targets SET sales_state='open' WHERE id=$1",
    ])
      await expect(pool.query(sql, [f.target])).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      "UPDATE pms.channex_offer_targets SET sales_state='open',sales_state_changed_at=now() WHERE id=$1",
      [f.target],
    );
    expect(await state()).toBe("open");
  });

  it("admits one guarded delivery per active target on the current job lease", async () => {
    const f = await fixture();
    await expect(f.deliver()).rejects.toThrow(
      "Active offer target and unresolved delivery required",
    );
    await pool.query("UPDATE pms.channex_offer_targets SET active_version=1 WHERE id=$1", [
      f.target,
    ]);
    await expect(f.deliver(undefined, "someone-else")).rejects.toThrow(
      "Active binding or job correlation mismatch",
    );
    await expect(f.deliver("{}")).rejects.toMatchObject({ code: "23514" });
    await expect(f.deliver(f.body("another-rate"))).rejects.toThrow(
      "Delivery values must target the active rate plan",
    );
    const delivery = (await f.deliver()).rows[0]!;
    expect(delivery).toMatchObject({ external: f.externalRate, version: "1" });
    await expect(f.deliver()).rejects.toMatchObject({ code: "23505" });

    await f.date(delivery.id, "2026-11-01");
    await f.date(delivery.id, "2026-11-02");
    const key = await pool.query(
      "SELECT binding_generation::text AS generation,external_rate_plan_id AS rate FROM pms.channex_offer_ari_delivery_dates WHERE delivery_id=$1 LIMIT 1",
      [delivery.id],
    );
    expect(key.rows[0]).toEqual({ generation: f.generation, rate: f.externalRate });
    await f.receipt(delivery.id);
    // Once Channex answered: no more dates, no release, only a reconciliation.
    await expect(f.date(delivery.id, "2026-11-03")).rejects.toThrow(
      "Dates belong to an unresolved, unsent delivery",
    );
    await expect(
      pool.query("UPDATE pms.channex_offer_ari_deliveries SET state='released' WHERE id=$1", [
        delivery.id,
      ]),
    ).rejects.toThrow("A delivery with a provider receipt cannot be released");
    await expect(
      pool.query(
        "UPDATE pms.channex_offer_ari_deliveries SET external_rate_plan_id='moved' WHERE id=$1",
        [delivery.id],
      ),
    ).rejects.toThrow("Offer ARI delivery identity and terminal state retained");
    await pool.query(
      `UPDATE pms.channex_offer_ari_deliveries SET state='reconciled',
         reconciliation_evidence='{"schemaVersion":"1"}' WHERE id=$1`,
      [delivery.id],
    );
    await expect(
      pool.query("DELETE FROM pms.channex_offer_ari_deliveries WHERE id=$1", [delivery.id]),
    ).rejects.toThrow("Offer ARI delivery history retained");

    // An unsent delivery may be released; the target is then free again.
    const unsent = (await f.deliver()).rows[0]!;
    await pool.query("UPDATE pms.channex_offer_ari_deliveries SET state='released' WHERE id=$1", [
      unsent.id,
    ]);
    // A finished job lease admits nothing.
    await pool.query("UPDATE platform.jobs SET status='succeeded',finished_at=now() WHERE id=$1", [
      f.job,
    ]);
    await expect(f.deliver()).rejects.toThrow("Active binding or job correlation mismatch");
  });

  it("leaves the API login only SELECT on the delivery tables", async () => {
    assertSafeTestDatabase(url!);
    // CI creates no runtime role before migrating, so run 0481's block as written against a role
    // holding the VAY-2054 default DML, inside a transaction that rolls the role and grants back.
    const migration = readFileSync(
      new URL("../migrations/0481_channex_offer_ari_deliveries.sql", import.meta.url),
      "utf8",
    );
    const revoke = migration.match(
      /DO \$\$ BEGIN\n {2}IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'vayada_next_api_runtime'\)[\s\S]*?END \$\$;/,
    )?.[0];
    expect(revoke).toBeDefined();
    const tables = ["deliveries", "delivery_dates", "delivery_receipts"].map(
      (name) => `pms.channex_offer_ari_${name}`,
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vayada_next_api_runtime') THEN
          CREATE ROLE vayada_next_api_runtime NOLOGIN;
        END IF; END $$`);
      await client.query(
        `GRANT USAGE ON SCHEMA pms TO vayada_next_api_runtime;
         GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables.join(",")} TO vayada_next_api_runtime`,
      );
      await client.query(revoke!);
      const privileges = await client.query(
        `SELECT t AS "table", has_table_privilege('vayada_next_api_runtime', t, 'SELECT') AS read,
           has_table_privilege('vayada_next_api_runtime', t, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS write
         FROM unnest($1::text[]) t`,
        [tables],
      );
      expect(privileges.rows).toEqual(tables.map((table) => ({ table, read: true, write: false })));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
