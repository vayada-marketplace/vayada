import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";

// VAY-2108 D3a (0521): worker row security on the 0520 delivery tables and the sales reset.
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("Channex ongoing offer ARI delivery scope", () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());

  it("secures the delivery tables for the worker through the target and the delivery", async () => {
    assertSafeTestDatabase(url!);
    const policies = (
      await pool.query<{ relation: string; name: string; permissive: string; qual: string }>(
        `SELECT schemaname||'.'||tablename AS relation,policyname AS name,permissive,qual
         FROM pg_policies WHERE tablename LIKE 'channex_offer_ari_deliver%' ORDER BY 1,2`,
      )
    ).rows;
    expect(policies.map((row) => [row.relation, row.name, row.permissive])).toEqual([
      ["pms.channex_offer_ari_deliveries", "channex_management_worker_compat", "PERMISSIVE"],
      ["pms.channex_offer_ari_deliveries", "channex_management_worker_scope", "RESTRICTIVE"],
      ["pms.channex_offer_ari_delivery_dates", "channex_management_worker_compat", "PERMISSIVE"],
      ["pms.channex_offer_ari_delivery_dates", "channex_management_worker_scope", "RESTRICTIVE"],
      ["pms.channex_offer_ari_delivery_receipts", "channex_management_worker_compat", "PERMISSIVE"],
      ["pms.channex_offer_ari_delivery_receipts", "channex_management_worker_scope", "RESTRICTIVE"],
    ]);
    const scopes = Object.fromEntries(
      policies.filter((row) => row.name.endsWith("_scope")).map((row) => [row.relation, row.qual]),
    );
    expect(scopes["pms.channex_offer_ari_deliveries"]).toContain(
      "channex_management_worker_source('target'::text, (target_id)::text)",
    );
    for (const relation of [
      "pms.channex_offer_ari_delivery_dates",
      "pms.channex_offer_ari_delivery_receipts",
    ])
      expect(scopes[relation]).toContain(
        "channex_management_worker_delivery_source('delivery'::text, (delivery_id)::text)",
      );
    const rls = (
      await pool.query<{ relation: string; enabled: boolean }>(
        `SELECT n.nspname||'.'||c.relname AS relation,c.relrowsecurity AS enabled FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname LIKE 'channex_offer_ari_deliver%'`,
      )
    ).rows;
    expect(rls.every((row) => row.enabled)).toBe(true);
    // Any other login passes the helper without reading worker tables; malformed input is false.
    const helper = (kind: string, resource: string | null) =>
      pool
        .query<{ ok: boolean }>(
          "SELECT platform.channex_management_worker_delivery_source($1,$2) AS ok",
          [kind, resource],
        )
        .then((result) => result.rows[0]!.ok);
    expect(await helper("delivery", randomUUID())).toBe(true);
    expect(await helper("other", null)).toBe(true);
    const definition = (
      await pool.query<{ src: string }>(
        "SELECT prosrc AS src FROM pg_proc WHERE proname='channex_management_worker_delivery_source'",
      )
    ).rows[0]!.src;
    expect(definition).toContain("current_user <> 'vayada_next_channex_management_worker'");
    expect(definition).toContain("FROM pms.channex_offer_ari_deliveries WHERE id = resource::uuid");
  });

  it("closes sales whenever the active version moves", async () => {
    assertSafeTestDatabase(url!);
    const property = randomUUID(),
      connection = randomUUID(),
      room = randomUUID(),
      externalProperty = randomUUID();
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Sales reset')",
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
    const seal = async () => {
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
        [target, intent.version, intent.id, generation, externalProperty, room, randomUUID()],
      );
      // Sealing the version marks the intent sealed (0314), so the next intent may be pending.
      return intent.version as string;
    };
    const state = async () =>
      (
        await pool.query<{ sales_state: string; changed: boolean; active: string | null }>(
          `SELECT sales_state,sales_state_changed_at IS NOT NULL AS changed,active_version::text AS active
           FROM pms.channex_offer_targets WHERE id=$1`,
          [target],
        )
      ).rows[0];
    const first = await seal();
    await pool.query("UPDATE pms.channex_offer_targets SET active_version=$2 WHERE id=$1", [
      target,
      first,
    ]);
    expect(await state()).toMatchObject({ sales_state: "closed", active: first });
    await pool.query(
      "UPDATE pms.channex_offer_targets SET sales_state='open',sales_state_changed_at=now() WHERE id=$1",
      [target],
    );
    expect(await state()).toMatchObject({ sales_state: "open", changed: true });
    // A no-op update of the pointer keeps the state; a move closes it.
    await pool.query("UPDATE pms.channex_offer_targets SET active_version=$2 WHERE id=$1", [
      target,
      first,
    ]);
    expect(await state()).toMatchObject({ sales_state: "open" });
    const second = await seal();
    await pool.query("UPDATE pms.channex_offer_targets SET active_version=$2 WHERE id=$1", [
      target,
      second,
    ]);
    expect(await state()).toMatchObject({ sales_state: "closed", changed: true, active: second });
  });
});
