import { randomUUID } from "node:crypto";
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
      external = randomUUID(),
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
      "INSERT INTO pms.channel_connections(id,property_id,provider) VALUES($1,$2,'channex')",
      [connection, property],
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
      [target, intent.version, intent.id, generation, property, room, external],
    );
    const job = (
      await pool.query(
        `INSERT INTO platform.jobs(job_key,queue_name,job_type,tenant_scope,property_id)
         VALUES($1,'pms.channex.management','channex.sync_ari','property',$2) RETURNING id::text`,
        [`vay-2108-delivery:${property}`, property],
      )
    ).rows[0].id as string;
    const jobAttempt = (
      await pool.query(
        `INSERT INTO platform.job_attempts(job_id,attempt_number,status,worker_id)
         VALUES($1,1,'running',$2) RETURNING id::text`,
        [job, worker],
      )
    ).rows[0].id as string;
    const deliver = (identity: Record<string, string> = {}) =>
      pool.query<{ id: string; external: string; version: string }>(
        `INSERT INTO pms.channex_offer_ari_deliveries
           (target_id,version,binding_generation,external_property_id,external_room_type_id,
            external_rate_plan_id,job_attempt_id,worker_id,request_body)
         VALUES($1,99,gen_random_uuid(),'forged','forged',$2,$3,$4,
           '{"values":[{"date_from":"2026-11-01","date_to":"2026-11-02","stop_sell":true}]}')
         RETURNING id::text,external_rate_plan_id AS external,version::text`,
        [target, identity.rate ?? "forged", jobAttempt, identity.worker ?? worker],
      );
    return { target, external, generation, jobAttempt, worker, deliver };
  }

  it("keeps sales closed by default and accepts only the two states", async () => {
    const f = await fixture();
    const state = async () =>
      (
        await pool.query("SELECT sales_state FROM pms.channex_offer_targets WHERE id=$1", [
          f.target,
        ])
      ).rows[0].sales_state;
    expect(await state()).toBe("closed");
    await expect(
      pool.query("UPDATE pms.channex_offer_targets SET sales_state='half' WHERE id=$1", [f.target]),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      "UPDATE pms.channex_offer_targets SET sales_state='open',sales_state_changed_at=now() WHERE id=$1",
      [f.target],
    );
    expect(await state()).toBe("open");
  });

  it("copies delivery identity from the active version and admits one unresolved delivery", async () => {
    const f = await fixture();
    await expect(f.deliver()).rejects.toThrow(
      "Active offer target and unresolved delivery required",
    );
    await pool.query("UPDATE pms.channex_offer_targets SET active_version=1 WHERE id=$1", [
      f.target,
    ]);
    await expect(f.deliver({ worker: "someone-else" })).rejects.toThrow(
      "Active binding or job correlation mismatch",
    );
    const delivery = (await f.deliver()).rows[0]!;
    expect(delivery).toMatchObject({ external: f.external, version: "1" });
    await expect(f.deliver()).rejects.toMatchObject({ code: "23505" });

    const date = (day: string, deliveryId = delivery.id) =>
      pool.query(
        `INSERT INTO pms.channex_offer_ari_delivery_dates(delivery_id,service_date,value,value_sha256)
         VALUES($1,$2,'{"stop_sell":true}',repeat('a',64))`,
        [deliveryId, day],
      );
    await date("2026-11-01");
    await date("2026-11-02");
    await expect(
      pool.query(
        "UPDATE pms.channex_offer_ari_delivery_dates SET value_sha256=repeat('b',64) WHERE delivery_id=$1",
        [delivery.id],
      ),
    ).rejects.toThrow("Offer ARI delivery dates retained");

    const receipt = randomUUID();
    await pool.query(
      `INSERT INTO pms.channex_offer_ari_delivery_receipts
         (id,delivery_id,job_attempt_id,worker_id,outcome,http_status,task_ids,has_warnings)
       VALUES($1,$2,$3,$4,'complete_json',200,ARRAY[gen_random_uuid()],false)`,
      [receipt, delivery.id, f.jobAttempt, f.worker],
    );
    await expect(
      pool.query(
        "UPDATE pms.channex_offer_ari_delivery_receipts SET has_warnings=true WHERE id=$1",
        [receipt],
      ),
    ).rejects.toThrow("Offer ARI delivery receipts retained");

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
    await expect(date("2026-11-03")).rejects.toThrow("Dates belong to an unresolved delivery");
    await expect(
      pool.query(
        "UPDATE pms.channex_offer_ari_deliveries SET state='released',reconciliation_evidence='{}' WHERE id=$1",
        [delivery.id],
      ),
    ).rejects.toThrow("Offer ARI delivery identity and terminal state retained");
    await expect(
      pool.query("DELETE FROM pms.channex_offer_ari_deliveries WHERE id=$1", [delivery.id]),
    ).rejects.toThrow("Offer ARI delivery history retained");
    // The target is free again for the next delivery once the previous one is terminal.
    expect((await f.deliver()).rows[0]).toMatchObject({ external: f.external });
  });
});
