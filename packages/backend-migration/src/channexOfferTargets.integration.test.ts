import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testUtils.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("Channex offer target storage", () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());
  async function fixture() {
    assertSafeTestDatabase(url!);
    const property = randomUUID(),
      connection = randomUUID(),
      room = randomUUID();
    await pool.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Target test')",
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
    const target = async (offer: string = randomUUID()) =>
      (
        await pool.query(
          "INSERT INTO pms.channex_offer_targets(property_id,connection_id,room_type_id,offer_id) VALUES($1,$2,$3,$4) RETURNING id",
          [property, connection, room, offer],
        )
      ).rows[0].id as string;
    const intent = async (id: string) =>
      (
        await pool.query(
          'INSERT INTO pms.channex_offer_target_intents(target_id,operation_key,proposal) VALUES($1,$2,\'{"currency":"EUR"}\') RETURNING id,version',
          [id, randomUUID()],
        )
      ).rows[0];
    const seal = (
      id: string,
      i: { id: string; version: string },
      external: string = randomUUID(),
    ) =>
      pool.query(
        `INSERT INTO pms.channex_offer_target_versions
      (target_id,version,intent_id,binding_generation,external_property_id,external_room_type_id,external_rate_plan_id,configuration,readback_evidence)
      VALUES($1,$2,$3,1,$4,$5,$6,'{"currency":"EUR"}','{"verified":true}')`,
        [id, i.version, i.id, property, room, external],
      );
    return { property, connection, room, target, intent, seal };
  }
  it("allocates retained versions, seals atomically and preserves active history on failure", async () => {
    const f = await fixture(),
      t = await f.target(),
      first = await f.intent(t),
      external = randomUUID();
    expect(first.version).toBe("1");
    await f.seal(t, first, external);
    await pool.query("UPDATE pms.channex_offer_targets SET active_version=1 WHERE id=$1", [t]);
    const second = await f.intent(t);
    expect(second.version).toBe("2");
    await pool.query("UPDATE pms.channex_offer_target_intents SET status='failed' WHERE id=$1", [
      second.id,
    ]);
    const third = await f.intent(t);
    expect(third.version).toBe("3");
    await f.seal(t, third, external);
    expect(
      (await pool.query("SELECT active_version FROM pms.channex_offer_targets WHERE id=$1", [t]))
        .rows[0].active_version,
    ).toBe("1");
    expect(
      (
        await pool.query("SELECT status FROM pms.channex_offer_target_intents WHERE id=$1", [
          third.id,
        ])
      ).rows[0].status,
    ).toBe("sealed");
    await expect(
      pool.query(
        "UPDATE pms.channex_offer_target_versions SET external_rate_plan_id='changed' WHERE target_id=$1",
        [t],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM pms.channex_offer_target_versions WHERE target_id=$1", [t]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("DELETE FROM pms.channex_external_rate_owners WHERE connection_id=$1", [
        f.connection,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE pms.channex_offer_target_intents SET status='pending' WHERE id=$1", [
        second.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE pms.channex_offer_targets SET next_version=1 WHERE id=$1", [t]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("enforces scope and does not select another target's active version", async () => {
    const f = await fixture(),
      g = await fixture(),
      t = await f.target("same"),
      u = await f.target();
    await expect(f.target("same")).rejects.toMatchObject({ code: "23505" });
    await expect(f.target(" ")).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "INSERT INTO pms.channex_offer_targets(property_id,connection_id,room_type_id,offer_id) VALUES($1,$2,$3,'foreign')",
        [f.property, g.connection, f.room],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query(
        "INSERT INTO pms.channex_offer_targets(property_id,connection_id,room_type_id,offer_id) VALUES($1,$2,$3,'foreign')",
        [f.property, f.connection, g.room],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await f.seal(u, await f.intent(u));
    await expect(
      pool.query("UPDATE pms.channex_offer_targets SET active_version=1 WHERE id=$1", [t]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query("UPDATE pms.channex_offer_targets SET offer_id='retarget' WHERE id=$1", [t]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("serializes competing pending intents and external rate claims", async () => {
    const f = await fixture(),
      t = await f.target();
    const pending = await Promise.allSettled([f.intent(t), f.intent(t)]);
    expect(pending.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(pending.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "23505" },
    });
    const u = await f.target(),
      v = await f.target(),
      ui = await f.intent(u),
      vi = await f.intent(v),
      external = randomUUID();
    const sealed = await Promise.allSettled([f.seal(u, ui, external), f.seal(v, vi, external)]);
    expect(sealed.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(sealed.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "23514" },
    });
    const loser = sealed[0].status === "rejected" ? ui : vi;
    expect(
      (
        await pool.query("SELECT status FROM pms.channex_offer_target_intents WHERE id=$1", [
          loser.id,
        ])
      ).rows[0].status,
    ).toBe("pending");
  });
  it("rejects an incomplete seal and preserves pending identity until success", async () => {
    const f = await fixture(),
      t = await f.target(),
      i = await f.intent(t);
    await expect(
      pool.query("UPDATE pms.channex_offer_target_intents SET status='sealed' WHERE id=$1", [i.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("UPDATE pms.channex_offer_target_intents SET proposal='{}' WHERE id=$1", [i.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(f.seal(t, i, "")).rejects.toMatchObject({ code: "23514" });
    await f.seal(t, i);
  });
  it("prevents legacy and replacement stores from claiming each other's provider rate", async () => {
    const f = await fixture(),
      rate = randomUUID(),
      legacy = randomUUID(),
      external = randomUUID();
    await pool.query(
      "INSERT INTO pms.rate_plans(id,property_id,room_type_id,code,currency,name) VALUES($1,$2,$3,'retained','EUR','Retained')",
      [rate, f.property, f.room],
    );
    const old = (id: string, ext: string) =>
      pool.query(
        `INSERT INTO pms.channel_rate_plan_mappings
      (id,property_id,connection_id,room_type_id,rate_plan_id,channel,external_room_type_id,external_rate_plan_id)
      VALUES($1::uuid,$2,$3,$4::uuid,$5,$1::text,$4::text,$6)`,
        [id, f.property, f.connection, f.room, rate, ext],
      );
    await old(legacy, external);
    // Match the production retry: INSERT generates a new UUID before conflict resolution.
    await pool.query(
      `INSERT INTO pms.channel_rate_plan_mappings
       (property_id,connection_id,room_type_id,rate_plan_id,channel,external_room_type_id,external_rate_plan_id)
       SELECT property_id,connection_id,room_type_id,rate_plan_id,channel,external_room_type_id,external_rate_plan_id
       FROM pms.channel_rate_plan_mappings WHERE id=$1
       ON CONFLICT(connection_id,rate_plan_id,channel) DO UPDATE SET status=EXCLUDED.status`,
      [legacy],
    );
    const t = await f.target(),
      i = await f.intent(t);
    await expect(f.seal(t, i, external)).rejects.toMatchObject({ code: "23514" });
    const owned = randomUUID();
    await f.seal(t, i, owned);
    await expect(old(randomUUID(), owned)).rejects.toMatchObject({ code: "23514" });
    await pool.query("DELETE FROM pms.channel_rate_plan_mappings WHERE id=$1", [legacy]);
    await old(legacy, external);
    await pool.query("DELETE FROM pms.channel_rate_plan_mappings WHERE id=$1", [legacy]);
    // Reusing the UUID must not transfer its provider identity to a different channel.
    await expect(
      pool.query(
        `INSERT INTO pms.channel_rate_plan_mappings
       (id,property_id,connection_id,room_type_id,rate_plan_id,channel,external_room_type_id,external_rate_plan_id)
       VALUES($1,$2,$3,$4::uuid,$5,'retarget',$4::text,$6)`,
        [legacy, f.property, f.connection, f.room, rate, external],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const retainedTarget = await f.target();
    await expect(
      f.seal(retainedTarget, await f.intent(retainedTarget), external),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(old(randomUUID(), external)).rejects.toMatchObject({ code: "23514" });
  });
});
