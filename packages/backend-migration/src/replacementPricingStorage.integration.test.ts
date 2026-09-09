import { randomUUID } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";
import { assertSafeTestDatabase } from "./testUtils.js";
const connectionString = process.env["TEST_DATABASE_URL"];
describe.skipIf(!connectionString)("replacement pricing storage constraints", () => {
  it("migrates and enforces scope, exact money, required fields and immutability", async () => {
    assertSafeTestDatabase(connectionString!);
    const result = await runMigrations({ connectionString: connectionString!, migrationsDir: join(import.meta.dirname, "../migrations"), environment: "local" });
    expect(result.failed).toBeNull();
    const client = new pg.Client({ connectionString }); await client.connect();
    await client.query("BEGIN");
    try {
      const property = randomUUID(), other = randomUUID(), room = randomUUID(), actor = randomUUID();
      await client.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Pricing test')", [actor, `${actor}@example.test`]);
      await client.query("INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Pricing test'),($2::uuid,$2::text,'Other')", [property, other]);
      await client.query("INSERT INTO pms.room_types(id,property_id,name,base_rate_amount,currency) VALUES($1,$2,'Room',100,'EUR')", [room, property]);
      await client.query("INSERT INTO pms.pricing_v2_heads(property_id) VALUES($1),($2)", [property, other]);
      for (const p of [property, other]) await client.query(`INSERT INTO pms.pricing_v2_revisions
        (property_id,revision,room_count,currency,source_revisions,owner_references,request_id,request_hash,actor_user_id)
        VALUES($1,1,$4,'EUR','{}','{}','request',$2,$3)`, [p, "a".repeat(64), actor, p === property ? 1 : 0]);
      const config = { version: "pricing.v2", propertyId: property, roomTypeId: room, revision: 1, currency: "EUR",
        capacity: { adults: 2, total: 2, children: 0 }, offers: [{ price: { mode: "flat", amountMinor: "10000" } }] };
      const insert = (p: string, c: unknown) => client.query(`INSERT INTO pms.pricing_v2_rooms
        (property_id,revision,room_type_id,currency,configuration) VALUES($1,1,$2,'EUR',$3)`, [p, room, JSON.stringify(c)]);
      const rejects = async (action: () => Promise<unknown>) => {
        await client.query("SAVEPOINT invalid");
        await expect(action()).rejects.toThrow();
        await client.query("ROLLBACK TO SAVEPOINT invalid");
      };
      await rejects(() => insert(other, { ...config, propertyId: other }));
      await rejects(() => insert(property, {}));
      await rejects(() => insert(property, { ...config, offers: [{ amountMinor: 100.5 }] }));
      await rejects(() => insert(property, { ...config, capacity: { adults: 0, total: 2, children: 0 } }));
      await insert(property, config);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      const secondRoom = randomUUID();
      await client.query("INSERT INTO pms.room_types(id,property_id,name,base_rate_amount,currency) VALUES($1,$2,'Second',100,'EUR')", [secondRoom, property]);
      await rejects(() => client.query(`INSERT INTO pms.pricing_v2_rooms
        (property_id,revision,room_type_id,currency,configuration) VALUES($1,1,$2,'EUR',$3)`,
        [property, secondRoom, JSON.stringify({ ...config, roomTypeId: secondRoom })]));
      await rejects(() => client.query("UPDATE pms.pricing_v2_heads SET revision=99 WHERE property_id=$1", [property]));
      await rejects(() => insert(property, config));
      await rejects(() => client.query("UPDATE pms.pricing_v2_rooms SET configuration='{}' WHERE property_id=$1", [property]));
      await rejects(() => client.query("DELETE FROM pms.pricing_v2_revisions WHERE property_id=$1", [property]));
      expect((await client.query("SELECT configuration FROM pms.pricing_v2_rooms WHERE property_id=$1", [property])).rows[0].configuration).toEqual(config);
    } finally { await client.query("ROLLBACK"); await client.end(); }
  }, 120000);
});
