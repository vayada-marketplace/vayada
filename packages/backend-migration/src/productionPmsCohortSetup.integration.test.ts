import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PMS_ROOM_FACTS_CONTRACT_VERSION, parseRoomTypeFactsSnapshot } from "@vayada/domain-pms";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeProductionMigrationProvenance } from "./productionBookingWriter.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { buildProductionPmsPlan } from "./productionPmsPlan.js";
import {
  readProductionPmsPrerequisites,
  readProductionPmsTargetState,
} from "./productionPmsTargetReader.js";
import type { PmsTargetRecord } from "./productionPmsTypes.js";
import { writeProductionPmsRecords } from "./productionPmsWriter.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const RUN = "vay1351-13620000000000000000c0a1";
const AT = "2026-09-04T00:00:00.000Z";
const ORGANIZATION = "13620000-0000-4000-8000-0000000000a0";
const PROPERTY = "13620000-0000-4000-8000-0000000000a1";
const NATIVE_PROPERTY = "13620000-0000-4000-8000-0000000000a2";
const HOTEL = "13620000-0000-4000-8000-0000000000a3";
const ROOM_TYPE = "13620000-0000-4000-8000-0000000000a4";
const ROOM_A = "13620000-0000-4000-8000-0000000000a5";
const ROOM_B = "13620000-0000-4000-8000-0000000000a6";

describe.skipIf(!URL)("production PMS cohort setup completeness (PostgreSQL)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    client = new pg.Client({ connectionString: URL });
    await client.connect();
  });
  afterAll(async () => client.end());

  it("gives a cohort hotel native pricing settings and verified room labels", async () => {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    try {
      await seed(client);
      const prerequisites = await readProductionPmsPrerequisites(client, RUN);
      const plan = async (records: PmsTargetRecord[] = []) =>
        buildProductionPmsPlan({
          sourceRunId: RUN,
          snapshotAt: AT,
          completedAt: AT,
          rows: sourceRows(),
          cohort: { bookingHotelIds: [], pmsHotelIds: [HOTEL], marketplaceHotelIds: [] },
          target: await readProductionPmsTargetState(client, records, prerequisites),
        });
      const planned = await plan((await plan()).records);
      expect(planned.blockers).toEqual([]);
      const written = await writeProductionPmsRecords(client, planned.writes);
      expect([written["property_pricing_settings"], written["rooms"]]).toEqual([1, 2]);
      await writeProductionMigrationProvenance(client, planned.provenance, RUN);
      // Fire the deferred triggers (0448 first-currency completion) as a commit would.
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      const verified = await plan(planned.records);
      expect([verified.blockers, verified.writes, verified.checksum]).toEqual([
        [],
        [],
        planned.checksum,
      ]);

      // The native room-facts read (pmsRoomFactsSnapshotFromRow) accepts the stored room type.
      const roomType = (
        await client.query<{ row: Record<string, unknown> }>(
          `SELECT to_jsonb(room_type) AS row FROM pms.room_types room_type WHERE id = $1`,
          [ROOM_TYPE],
        )
      ).rows[0]!.row;
      const occupancy = roomType["occupancy_limits"] as Record<string, unknown>;
      const attributes = roomType["room_attributes"] as Record<string, unknown>;
      expect(
        parseRoomTypeFactsSnapshot({
          contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
          propertyId: PROPERTY,
          roomTypeId: ROOM_TYPE,
          roomFactsRevision: roomType["room_facts_revision"],
          lifecycle: "active",
          facts: {
            name: roomType["name"],
            description: roomType["description"],
            category: roomType["category"],
            occupancy: {
              maxGuests: occupancy["total"],
              maxAdults: occupancy["adults"],
              maxChildren: occupancy["children"],
            },
            beds: attributes["beds"],
            bedrooms: attributes["bedrooms"],
            bathrooms: attributes["bathrooms"],
            bathroomType: attributes["bathroomType"],
            size: attributes["size"],
          },
          createdAt: AT,
          updatedAt: AT,
        }),
      ).toMatchObject({ facts: { category: "standard", size: { value: 18, unit: "sqm" } } });

      // The same row the native first-currency insert writes, run from its own source text.
      const source = await readFile(
        join(import.meta.dirname, "../../../apps/api/src/domains/pmsPricingCommandRepository.ts"),
        "utf8",
      );
      const nativeInsert =
        /`(INSERT INTO pms\.property_pricing_settings[^`]*?VALUES \([^)]*\))/.exec(source)?.[1];
      expect(nativeInsert).toBeDefined();
      await client.query(nativeInsert!, [NATIVE_PROPERTY, "EUR", AT]);
      const pricing = await client.query<{ propertyId: string; shape: unknown }>(
        `SELECT property_id::text AS "propertyId", to_jsonb(settings) - 'property_id' AS shape
           FROM pms.property_pricing_settings settings
          WHERE property_id = ANY($1::uuid[]) ORDER BY property_id`,
        [[PROPERTY, NATIVE_PROPERTY]],
      );
      expect(pricing.rows[0]!.shape).toEqual(pricing.rows[1]!.shape);
      expect(pricing.rows[0]!.shape).toMatchObject({
        currency: "EUR",
        pricing_currency_revision: 1,
        optional_pricing_aggregate_revision: 0,
      });

      // The VAY-2066 producer's room gate (pmsChannexScheduler) now selects the hotel.
      const unverified = await client.query(
        `SELECT 1 FROM pms.rooms physical_room
           JOIN pms.room_types room_type ON room_type.property_id = physical_room.property_id
            AND room_type.id = physical_room.room_type_id AND room_type.active IS TRUE
          WHERE physical_room.property_id = $1 AND physical_room.status <> 'retired'
            AND (physical_room.operational_label_status <> 'verified'
                 OR physical_room.room_number IS NULL)`,
        [PROPERTY],
      );
      expect(unverified.rows).toEqual([]);

      // A verified label elsewhere in the property blocks the plan, not the unique index.
      await client.query(`UPDATE pms.rooms SET room_number = 'X-102' WHERE id = $1`, [ROOM_B]);
      await client.query(
        `INSERT INTO pms.rooms (property_id, room_type_id, room_number, operational_label_status)
         VALUES ($1, $2, 'a-102', 'verified')`,
        [PROPERTY, ROOM_TYPE],
      );
      expect((await plan(planned.records)).blockers).toContainEqual(
        expect.objectContaining({
          code: "TARGET_UNIQUE_CONFLICT",
          message: "Another verified room owns this case-insensitive property room label",
        }),
      );
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

async function seed(client: pg.Client): Promise<void> {
  await client.query(
    `INSERT INTO identity.organizations (id, kind, name, slug)
     VALUES ($1, 'hotel_group', 'Cohort setup', 'cohort-setup-integration')`,
    [ORGANIZATION],
  );
  await client.query(
    `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
     VALUES ($1, 'cohort-setup', 'Cohort setup'), ($2, 'cohort-setup-native', 'Native')`,
    [PROPERTY, NATIVE_PROPERTY],
  );
  await client.query(
    `INSERT INTO hotel_catalog.property_source_links
       (property_id, source_system, source_table, source_id, relationship, metadata)
     VALUES ($1, 'pms', 'hotels', $2, 'operational_input', $3::jsonb)`,
    [PROPERTY, HOTEL, JSON.stringify({ migrationRunId: RUN, migrationDisposition: "canonical" })],
  );
  await client.query(
    `INSERT INTO identity.organization_resource_links
       (organization_id, product, resource_type, resource_id, relationship, status)
     VALUES ($1, 'pms', 'pms_hotel', $2, 'operator', 'active')`,
    [ORGANIZATION, HOTEL],
  );
}

function sourceRows(): IdentitySourceRow[] {
  const row = (sourceTable: string, data: Record<string, unknown>): IdentitySourceRow => ({
    sourceDatabase: "pms",
    sourceTable,
    rowOrdinal: 1,
    data: { created_at: "2026-01-01T00:00:00Z", updated_at: "2026-08-29T00:00:00Z", ...data },
  });
  const room = (id: string, number: string) =>
    row("rooms", { id, hotel_id: HOTEL, room_type_id: ROOM_TYPE, room_number: number });
  return [
    row("hotels", { id: HOTEL, timezone: "Europe/Berlin" }),
    row("room_types", {
      id: ROOM_TYPE,
      hotel_id: HOTEL,
      name: "Double",
      total_rooms: 2,
      base_rate: "100.00",
      currency: "EUR",
      is_active: true,
      category: "Standard",
      bed_type: "1 Double Bed",
      size: 18,
    }),
    room(ROOM_A, "A-101"),
    room(ROOM_B, "A-102"),
  ];
}
