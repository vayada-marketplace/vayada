import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { readCurrentPricingSnapshot } from "./replacementPricingSnapshot.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("complete published pricing snapshots", () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());
  async function fixture(work: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
    if (!url || !/(^|[_-])test([_-]|$)/i.test(new URL(url).pathname.slice(1)))
      throw new Error("test database required");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await work(await setup(client));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
  async function setup(client: PoolClient) {
    const propertyId = randomUUID(),
      actor = randomUUID(),
      roomTypeId = randomUUID();
    await client.query("INSERT INTO identity.users(id,email,name) VALUES($1,$2,'Snapshot test')", [
      actor,
      `${actor}@example.test`,
    ]);
    await client.query(
      "INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1::uuid,$1::text,'Snapshot test')",
      [propertyId],
    );
    await client.query(
      "INSERT INTO pms.room_types(id,property_id,name,base_rate_amount,currency) VALUES($1,$2,'Room',100,'EUR')",
      [roomTypeId, propertyId],
    );
    await lockPmsInventoryMutationScope(client, propertyId);
    const configuration = (revision: number) => ({
      version: "pricing.v2",
      propertyId,
      roomTypeId,
      revision,
      currency: "EUR",
      capacity: { total: 2, adults: 2, children: 0 },
      children: {
        adultFromAge: 18,
        bands: [{ fromAge: 0, throughAge: 17, nightlyMinor: "0", countsTowardCapacity: true }],
      },
      offers: [
        {
          id: "standard",
          termsRevision: "terms-1",
          meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
          price: {
            kind: "independent",
            calendar: {
              base: { mode: "occupancy", amountsMinor: ["10000", "12000"] },
              months: [],
              seasons: [],
              weekdays: [],
              dates: [],
            },
          },
          restrictions: {
            kind: "own",
            rules: {
              minArrivalNights: 1,
              maxStayNights: null,
              closedToArrival: false,
              closedToDeparture: false,
              stopSell: false,
            },
            seasons: [],
            dates: [],
          },
        },
      ],
    });
    const sources = { room: "room-1", terms: "terms-1", finance: "finance-1" };
    const ownerReferences = { finance: "evidence-1", charges: "charges-1" };
    async function revision(
      n: number,
      roomCount = 1,
      refs: unknown = sources,
      owners: unknown = ownerReferences,
    ) {
      await client.query(
        `INSERT INTO pms.pricing_v2_revisions(property_id,revision,room_count,currency,source_revisions,owner_references,request_id,request_hash,actor_user_id)
        VALUES($1,$2,$3,'EUR',$4,$5,$6,$7,$8)`,
        [
          propertyId,
          n,
          roomCount,
          JSON.stringify(refs),
          JSON.stringify(owners),
          randomUUID(),
          "a".repeat(64),
          actor,
        ],
      );
    }
    async function room(n: number, config: unknown = configuration(n)) {
      await client.query(
        `INSERT INTO pms.pricing_v2_rooms(property_id,revision,room_type_id,currency,configuration)
        VALUES($1,$2,$3,'EUR',$4)`,
        [propertyId, n, roomTypeId, JSON.stringify(config)],
      );
    }
    const head = (n: number) =>
      client.query(
        "INSERT INTO pms.pricing_v2_heads(property_id,revision) VALUES($1,$2) ON CONFLICT(property_id) DO UPDATE SET revision=$2",
        [propertyId, n],
      );
    const read = () => readCurrentPricingSnapshot(client, propertyId);
    return {
      client,
      propertyId,
      actor,
      configuration,
      sources,
      ownerReferences,
      revision,
      room,
      head,
      read,
    };
  }
  it("returns no publication for absent and draft-only heads", () =>
    fixture(async (f) => {
      expect(await f.read()).toBeNull();
      await f.head(0);
      await f.client.query(
        `INSERT INTO pms.pricing_v2_drafts(property_id,draft_id,draft_revision,base_revision,source_revisions,snapshot,actor_user_id)
      VALUES($1,$2,1,0,$3,$4,$5)`,
        [
          f.propertyId,
          randomUUID(),
          JSON.stringify(f.sources),
          JSON.stringify({
            currency: "EUR",
            rooms: [f.configuration(1)],
            ownerReferences: f.ownerReferences,
          }),
          f.actor,
        ],
      );
      expect(await f.read()).toBeNull();
    }));
  it("reads the exact active head, not newer history, and returns detached complete data", () =>
    fixture(async (f) => {
      await f.head(0);
      for (const n of [1, 2]) {
        await f.revision(n);
        await f.room(n);
      }
      await f.head(1);
      await f.client.query("SET CONSTRAINTS ALL IMMEDIATE");
      const expected = {
        revision: 1,
        currency: "EUR",
        rooms: [f.configuration(1)],
        sources: f.sources,
        ownerReferences: f.ownerReferences,
      };
      const result = await f.read();
      expect(result).toEqual(expected);
      (result!.sources as Record<string, string>).room = "changed";
      expect(await f.read()).toEqual(expected);
    }));
  it("allows a deliberately empty complete revision", () =>
    fixture(async (f) => {
      await f.head(0);
      await f.revision(1, 0);
      await f.head(1);
      await f.client.query("SET CONSTRAINTS ALL IMMEDIATE");
      expect(await f.read()).toMatchObject({ revision: 1, rooms: [] });
    }));
  // Deferred constraints let the test inspect malformed in-flight revisions without
  // disabling schema guards or persisting corrupt data. Every fixture rolls back.
  it("rejects a dangling active head", () =>
    fixture(async (f) => {
      await f.head(1);
      await expect(f.read()).rejects.toMatchObject({ code: "invalid" });
    }));
  it.each([0, 2])("rejects a room count of %i when one row exists", (count) =>
    fixture(async (f) => {
      await f.head(0);
      await f.revision(1, count);
      await f.room(1);
      await f.head(1);
      await expect(f.read()).rejects.toMatchObject({ code: "invalid" });
    }),
  );
  it.each([{}, { room: "" }, { room: 1 }])("rejects invalid source references %j", (refs) =>
    fixture(async (f) => {
      await f.head(0);
      await f.revision(1, 1, refs);
      await f.room(1);
      await f.head(1);
      await expect(f.read()).rejects.toMatchObject({ code: "invalid" });
    }),
  );
  it("rejects invalid owner references", () =>
    fixture(async (f) => {
      await f.head(0);
      await f.revision(1, 1, f.sources, {});
      await f.room(1);
      await f.head(1);
      await expect(f.read()).rejects.toMatchObject({ code: "invalid" });
    }));
  it("rejects room data that passes storage shape constraints but fails domain parsing", () =>
    fixture(async (f) => {
      await f.head(0);
      await f.revision(1);
      await f.room(1, { ...f.configuration(1), children: { adultFromAge: -1, bands: [] } });
      await f.head(1);
      await expect(f.read()).rejects.toMatchObject({ code: "invalid" });
    }));
});
