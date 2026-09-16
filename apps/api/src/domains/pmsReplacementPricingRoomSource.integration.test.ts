import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { lockPmsReplacementPricingRoomSource as source } from "./pmsReplacementPricingRoomSource.js";
import { lockPmsRoomFactsMutationScope } from "./pmsRoomFactsMutationLock.js";
const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("PMS replacement pricing complete room source", () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  afterAll(() => pool.end());
  async function fixture() {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1))) throw new Error("test database required");
    const propertyId = randomUUID(), roomId = randomUUID();
    await pool.query("INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Room source test')", [propertyId]);
    await pool.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Room')", [roomId, propertyId]);
    return { propertyId, roomId };
  }
  // Source-port tests assume an authorized caller; combined-owner tests exercise live authorization.
  async function read(propertyId: string) {
    const client = await pool.connect();
    try { await client.query("BEGIN"); return await source(client, propertyId); }
    finally { await client.query("ROLLBACK"); client.release(); }
  }
  it("is stable, property scoped and independent of retired prices and physical-unit revisions", async () => {
    const f = await fixture(), other = await fixture(), first = await read(f.propertyId);
    expect(first).toMatch(/^pms\.pricing\.rooms\.v2:[a-f0-9]{64}$/);
    expect(await read(f.propertyId.toUpperCase())).toBe(first);
    expect(await read(other.propertyId)).not.toBe(first);
    expect(await read("invalid")).toBeNull();
    await pool.query("UPDATE pms.room_types SET base_rate_amount=100,currency='USD',room_units_revision=room_units_revision+1 WHERE id=$1", [f.roomId]);
    expect(await read(f.propertyId)).toBe(first);
    await pool.query("UPDATE pms.room_types SET occupancy_limits=$2 WHERE id=$1", [f.roomId, { total: 3, adults: 2 }]);
    const ordered = await read(f.propertyId);
    await pool.query("UPDATE pms.room_types SET occupancy_limits=$2 WHERE id=$1", [f.roomId, { adults: 2, total: 3 }]);
    expect(await read(f.propertyId)).toBe(ordered);
  });
  it("invalidates for facts, capacity, attributes, activity and complete-set membership", async () => {
    const f = await fixture(); let previous = await read(f.propertyId);
    for (const update of ["room_facts_revision=room_facts_revision+1", "occupancy_limits='{\"adults\":3}'::jsonb",
      "room_attributes='{\"beds\":2}'::jsonb", "active=false", "active=true",
      "room_attributes='{\"externalId\":9007199254740992}'::jsonb", "room_attributes='{\"externalId\":9007199254740993}'::jsonb"]) {
      await pool.query(`UPDATE pms.room_types SET ${update} WHERE id=$1`, [f.roomId]);
      const next = await read(f.propertyId); expect(next).not.toBe(previous); previous = next;
    }
    const added = randomUUID();
    await pool.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Added')", [added, f.propertyId]);
    const expanded = await read(f.propertyId); expect(expanded).not.toBe(previous);
    await pool.query("DELETE FROM pms.room_types WHERE id=$1", [added]);
    expect(await read(f.propertyId)).toBe(previous);
    await pool.query("DELETE FROM pms.room_types WHERE id=$1", [f.roomId]);
    const empty = await read(f.propertyId); expect(empty).not.toBe(previous);
    expect(await read(f.propertyId)).toBe(empty);
  });
  it("blocks existing-row changes and owner-locked room creation until transaction end", async () => {
    const f = await fixture(), reader = await pool.connect(), writer = await pool.connect();
    try {
      await writer.query("SET lock_timeout='150ms'");
      await reader.query("BEGIN"); const original = await source(reader, f.propertyId);
      await expect(writer.query("UPDATE pms.room_types SET active=false WHERE id=$1", [f.roomId])).rejects.toMatchObject({ code: "55P03" });
      await writer.query("BEGIN");
      // The real room-facts create/update/delete writer takes this same property lock.
      await expect(lockPmsRoomFactsMutationScope(writer, f.propertyId)).rejects.toMatchObject({ code: "55P03" });
      await writer.query("ROLLBACK"); await reader.query("COMMIT");
      await writer.query("BEGIN"); await lockPmsRoomFactsMutationScope(writer, f.propertyId);
      await writer.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Concurrent room')", [randomUUID(), f.propertyId]);
      await writer.query("COMMIT"); expect(await read(f.propertyId)).not.toBe(original);
    } finally {
      await reader.query("ROLLBACK"); await writer.query("ROLLBACK"); await writer.query("RESET lock_timeout");
      reader.release(); writer.release();
    }
  });
});
