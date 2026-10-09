import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PMS_ROOM_FACTS_CONTRACT_VERSION, parseRoomTypeFactsSnapshot } from "@vayada/domain-pms";
import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import {
  NATIVE_BED_LABELS,
  NATIVE_BED_TYPES,
  NATIVE_ROOM_CATEGORIES,
  cohortRoomFacts,
} from "./productionPmsCohortRoomFacts.js";
import { buildProductionPmsPlan } from "./productionPmsPlan.js";
import type { ProductionPmsTargetState } from "./productionPmsTypes.js";

const HOTEL = "10000000-0000-4000-a000-00000000000";
const PROPERTY = "20000000-0000-4000-a000-00000000000";
const ROOM_TYPE = "30000000-0000-4000-a000-00000000000";
const AT = "2026-10-09T00:00:00.000Z";
const API = join(import.meta.dirname, "../../../apps");

const legacy = {
  name: "Garden Double",
  description: "Quiet room",
  category: "Deluxe",
  max_occupancy: 3,
  max_adults: 2,
  max_children: null,
  bed_type: "1 King Bed, 2 single bed",
  bedrooms: 1,
  bathrooms: 1,
  size: 25,
};

/** The native room-facts read (apps/api pmsRoomFactsReadModel pmsRoomFactsSnapshotFromRow). */
function nativeRead(row: Record<string, unknown>) {
  const occupancy = row["occupancyLimits"] as Record<string, unknown>;
  const attributes = row["roomAttributes"] as Record<string, unknown>;
  const maxGuests = occupancy["total"];
  return parseRoomTypeFactsSnapshot({
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId: row["propertyId"],
    roomTypeId: row["id"],
    roomFactsRevision: 1,
    lifecycle: row["active"] ? "active" : "inactive",
    facts: {
      name: row["name"],
      description: row["description"],
      category: row["category"],
      occupancy: {
        maxGuests,
        maxAdults: occupancy["adults"] ?? maxGuests,
        maxChildren: occupancy["children"] ?? maxGuests,
      },
      beds: attributes["beds"],
      bedrooms: attributes["bedrooms"],
      bathrooms: attributes["bathrooms"],
      bathroomType: attributes["bathroomType"],
      size:
        typeof attributes["size"] === "number"
          ? { value: attributes["size"], unit: "sqm" }
          : attributes["size"],
    },
    createdAt: row["createdAt"],
    updatedAt: row["updatedAt"],
  });
}

function plan(cohort: boolean | "outside", roomType: Record<string, unknown> = legacy) {
  const row = (sourceTable: string, data: Record<string, unknown>): IdentitySourceRow => ({
    sourceDatabase: "pms",
    sourceTable,
    rowOrdinal: 1,
    data: { created_at: AT, updated_at: AT, ...data },
  });
  const target: ProductionPmsTargetState = {
    propertyLinks: [
      {
        sourceId: `${HOTEL}1`,
        propertyId: `${PROPERTY}1`,
        relationship: "operational_input",
        status: "active",
        migrationRunId: "run",
        migrationDisposition: "canonical",
        ownerStatus: "active",
      },
    ],
    bookings: [],
    userIds: [],
    mediaIds: [],
    records: [],
    provenance: [],
  };
  const result = buildProductionPmsPlan({
    sourceRunId: "run",
    snapshotAt: AT,
    completedAt: AT,
    rows: [
      row("hotels", { id: `${HOTEL}1` }),
      row("room_types", {
        id: `${ROOM_TYPE}1`,
        hotel_id: `${HOTEL}1`,
        total_rooms: 0,
        base_rate: "0",
        currency: "EUR",
        ...roomType,
      }),
    ],
    target,
    cohort: cohort
      ? {
          bookingHotelIds: [],
          pmsHotelIds: cohort === "outside" ? [] : [`${HOTEL}1`],
          marketplaceHotelIds: [],
        }
      : null,
  });
  expect(result.blockers).toEqual([]);
  return result.records.find((record) => record.targetTable === "room_types")!;
}

describe("production PMS cohort room facts", () => {
  it("maps a legacy room type as the native room form does", () => {
    expect(cohortRoomFacts(legacy)).toEqual({
      legacyCategory: null,
      facts: {
        name: "Garden Double",
        description: "Quiet room",
        category: "deluxe",
        occupancy: { maxGuests: 3, maxAdults: 2, maxChildren: 3 },
        beds: [
          { type: "king", quantity: 1 },
          { type: "single", quantity: 2 },
        ],
        bedrooms: 1,
        bathrooms: 1,
        bathroomType: "private",
        size: { value: 25, unit: "sqm" },
      },
    });
    expect(cohortRoomFacts({ ...legacy, category: "Garden", size: 0 })).toMatchObject({
      legacyCategory: "Garden",
      facts: { category: null, size: null },
    });
  });

  it("maps bed labels as the form and the native legacy read do, and 0 bathrooms as shared", () => {
    const beds = (bedType: string) => cohortRoomFacts({ ...legacy, bed_type: bedType })?.facts.beds;
    expect(beds("2 Single Beds")).toEqual([{ type: "single", quantity: 2 }]);
    expect(beds("Queen")).toEqual([{ type: "queen", quantity: 1 }]);
    expect(beds("1 Futon, King + Bunk")).toEqual([
      { type: "futon", quantity: 1 },
      { type: "king_bunk", quantity: 1 },
    ]);
    expect(cohortRoomFacts({ ...legacy, bathrooms: 0 })?.facts).toMatchObject({
      bathrooms: null,
      bathroomType: "shared",
    });
  });

  it.each([
    ["no bed", { bed_type: "" }],
    ["more than 20 beds of a type", { bed_type: "21 King Bed" }],
    ["more adults than guests", { max_adults: 4 }],
    ["fewer adults and children than guests", { max_adults: 2, max_children: 0 }],
  ])("keeps the legacy shape for %s", (_, values) => {
    expect(cohortRoomFacts({ ...legacy, ...values })).toBeNull();
  });

  it("stores cohort room types so the native room-facts read accepts them", () => {
    const record = plan(true);
    expect(record.row).toMatchObject({
      category: "deluxe",
      // Only the native keys: native edits merge, and stale legacy keys would win in readers.
      occupancyLimits: { total: 3, adults: 2, children: 3 },
      roomAttributes: {
        bathroomType: "private",
        legacyRoomFacts: {
          maxOccupancy: 3,
          maxAdults: 2,
          maxChildren: null,
          bedType: "1 King Bed, 2 single bed",
          size: 25,
        },
      },
    });
    expect(record.row["occupancyLimits"]).not.toHaveProperty("maxOccupancy");
    expect(record.row["roomAttributes"]).not.toHaveProperty("bedType");
    expect(nativeRead(record.row)).not.toBeNull();
    // Without a cohort, or outside it, the row keeps exactly its legacy shape and checksum.
    const legacyRecord = plan(false);
    expect(legacyRecord.row["occupancyLimits"]).toEqual({
      maxOccupancy: 3,
      maxAdults: 2,
      maxChildren: null,
    });
    expect(legacyRecord.row["category"]).toBe("Deluxe");
    expect(nativeRead(legacyRecord.row)).toBeNull();
    expect(legacyRecord.sourceChecksum).not.toBe(record.sourceChecksum);
    const outside = plan("outside");
    expect(outside.row).toEqual(legacyRecord.row);
    expect(outside.sourceChecksum).toBe(legacyRecord.sourceChecksum);
  });

  it("mirrors the native read, vocabulary and form labels", async () => {
    const read = await readFile(join(API, "api/src/domains/pmsRoomFactsReadModel.ts"), "utf8");
    for (const expression of [
      'const maxGuests = occupancy?.["total"];',
      'maxAdults: occupancy?.["adults"] ?? maxGuests,',
      'maxChildren: occupancy?.["children"] ?? maxGuests,',
      'beds: attributes?.["beds"] ?? legacyBeds(attributes?.["bedType"]),',
      'bathroomType: attributes?.["bathroomType"],',
      'size: legacyRoomSize(attributes?.["size"]),',
    ])
      expect(read).toContain(expression);
    const vocabulary = await readFile(
      join(API, "api/src/domains/pmsRoomFactsVocabulary.ts"),
      "utf8",
    );
    const set = (name: string) =>
      new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`)
        .exec(vocabulary)?.[1]
        ?.match(/[a-z_]+/g);
    expect(set("ROOM_CATEGORIES")?.sort()).toEqual([...NATIVE_ROOM_CATEGORIES].sort());
    expect(set("BED_TYPES")?.sort()).toEqual([...NATIVE_BED_TYPES].sort());
    const form = await readFile(join(API, "pms-web/services/rooms/roomFacts.ts"), "utf8");
    for (const [label, key] of Object.entries(NATIVE_BED_LABELS))
      expect(form).toContain(`"${label}": "${key}",`);
    expect(await readFile(join(API, "pms-web/app/(app)/rooms/new/page.tsx"), "utf8")).toContain(
      'bathroomType: "private"',
    );
  });
});
