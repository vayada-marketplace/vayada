import { createHash, randomUUID } from "node:crypto";
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
  it("invalidates for capacity and room-set membership, not for other room facts", async () => {
    const f = await fixture(); let previous = await read(f.propertyId);
    // VAY-2129: renaming, describing, re-photographing or deactivating a room keeps saved prices current.
    for (const update of ["room_facts_revision=room_facts_revision+1", "name='Renamed'", "description='New text'",
      "room_attributes='{\"beds\":2}'::jsonb", "active=false", "active=true"]) {
      await pool.query(`UPDATE pms.room_types SET ${update} WHERE id=$1`, [f.roomId]);
      expect(await read(f.propertyId)).toBe(previous);
    }
    await pool.query(`UPDATE pms.room_types SET occupancy_limits='{"adults":3}'::jsonb WHERE id=$1`, [f.roomId]);
    const next = await read(f.propertyId); expect(next).not.toBe(previous); previous = next;
    const added = randomUUID();
    await pool.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Added')", [added, f.propertyId]);
    const expanded = await read(f.propertyId); expect(expanded).not.toBe(previous);
    await pool.query("DELETE FROM pms.room_types WHERE id=$1", [added]);
    expect(await read(f.propertyId)).toBe(previous);
    await pool.query("DELETE FROM pms.room_types WHERE id=$1", [f.roomId]);
    const empty = await read(f.propertyId); expect(empty).not.toBe(previous);
    expect(await read(f.propertyId)).toBe(empty);
  });
  it("ignores rooms added after the saved prices when checking them", async () => {
    const f = await fixture(), actor = randomUUID(), client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Room source test')", [actor, `${actor}@example.test`]);
      const saved = await source(client, f.propertyId);
      // Deferred constraints let the head point at a room-less revision until the rollback below.
      await client.query("INSERT INTO pms.pricing_v2_heads(property_id) VALUES($1)", [f.propertyId]);
      await client.query(`INSERT INTO pms.pricing_v2_revisions
        (property_id,revision,currency,source_revisions,owner_references,request_id,request_hash,actor_user_id,room_count,created_at)
        VALUES($1,1,'EUR',$2,'{"terms":"t"}',$3,$4,$5,1,now()-interval '1 minute')`,
        [f.propertyId, { room: saved, terms: "t", finance: "f" }, randomUUID(), "a".repeat(64), actor]);
      await client.query("UPDATE pms.pricing_v2_heads SET revision=1 WHERE property_id=$1", [f.propertyId]);
      const checked = { revision: 1, roomTypeIds: [f.roomId] };
      await client.query("UPDATE pms.room_types SET created_at=now()-interval '1 hour' WHERE id=$1", [f.roomId]);
      expect(await source(client, f.propertyId, checked)).toBe(saved);
      const added = randomUUID();
      await client.query("INSERT INTO pms.room_types(id,property_id,name) VALUES($1,$2,'Added')", [added, f.propertyId]);
      expect(await source(client, f.propertyId, checked)).toBe(saved);
      expect(await source(client, f.propertyId)).not.toBe(saved);
      expect(await source(client, f.propertyId, { ...checked, roomTypeIds: [f.roomId, added] })).not.toBe(saved);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("keeps a source saved before VAY-2129 current until a room fact changes", async () => {
    const f = await fixture(), actor = randomUUID(), client = await pool.connect();
    const legacy = async () => {
      const rooms = (await client.query(`SELECT id,active,room_facts_revision::text AS revision,
        occupancy_limits::text AS occupancy_limits,room_attributes::text AS room_attributes
        FROM pms.room_types WHERE property_id=$1 ORDER BY id`, [f.propertyId])).rows;
      return "pms.pricing.rooms.v2:" + createHash("sha256").update(JSON.stringify({ propertyId: f.propertyId, rooms })).digest("hex");
    };
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Room source test')", [actor, `${actor}@example.test`]);
      const saved = await legacy();
      // Deferred constraints let the head point at a room-less revision until the rollback below.
      await client.query("INSERT INTO pms.pricing_v2_heads(property_id) VALUES($1)", [f.propertyId]);
      await client.query(`INSERT INTO pms.pricing_v2_revisions
        (property_id,revision,currency,source_revisions,owner_references,request_id,request_hash,actor_user_id,room_count)
        VALUES($1,1,'EUR',$2,'{"terms":"t"}',$3,$4,$5,1)`,
        [f.propertyId, { room: saved, terms: "t", finance: "f" }, randomUUID(), "a".repeat(64), actor]);
      await client.query("UPDATE pms.pricing_v2_heads SET revision=1 WHERE property_id=$1", [f.propertyId]);
      expect(await source(client, f.propertyId)).toBe(saved);
      await client.query("UPDATE pms.room_types SET name='Renamed',room_facts_revision=room_facts_revision+1 WHERE id=$1", [f.roomId]);
      const upgraded = await source(client, f.propertyId);
      expect(upgraded).not.toBe(saved);
      expect(upgraded).toMatch(/^pms\.pricing\.rooms\.v2:[a-f0-9]{64}$/);
    } finally { await client.query("ROLLBACK"); client.release(); }
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
