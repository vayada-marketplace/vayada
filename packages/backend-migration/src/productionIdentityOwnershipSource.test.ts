import { describe, expect, it } from "vitest";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import {
  mapOwnershipStatus,
  parseIdentityOwnershipRows,
  stableOrganizationId,
} from "./productionIdentityOwnershipSource.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const RESOURCE_ID = "22222222-2222-4222-8222-222222222222";
const CREATED = "2026-01-01T00:00:00.000Z";

describe("production ownership source mapping", () => {
  it("derives stable organization UUIDs without source-table IDs", () => {
    expect(stableOrganizationId(USER_ID, "hotel_group")).toBe(
      "dcaad57f-4290-5899-ba7b-786d4a38e4bb",
    );
  });

  it.each([
    ["booking.booking_hotels", "live", "active"],
    ["booking.booking_hotels", "retired", null],
    ["pms.hotels", null, "active"],
    ["marketplace.hotel_profiles", "verified", null],
  ] as const)("maps %s %s to %s", (source, status, expected) => {
    expect(mapOwnershipStatus(source, status)).toBe(expected);
  });

  it("maps Booking and PMS hotels into one explicit ownership shape", () => {
    const rows = [
      row("booking", "booking_hotels", { platform_status: "live" }),
      row("pms", "hotels"),
      // VAY-2272: the retired Marketplace and affiliate program own nothing any more.
      row("marketplace", "hotel_profiles", { status: "verified" }),
      row("marketplace", "creators"),
      row("pms", "affiliates", { status: "approved", full_name: "Affiliate Owner" }),
    ];

    const result = parseIdentityOwnershipRows(rows);

    expect(result.blockers).toEqual([]);
    expect(
      result.owners.map(({ source, kind, product, resourceType, relationship }) => ({
        source,
        kind,
        product,
        resourceType,
        relationship,
      })),
    ).toEqual([
      {
        source: "booking.booking_hotels",
        kind: "hotel_group",
        product: "booking",
        resourceType: "booking_hotel",
        relationship: "owner",
      },
      {
        source: "pms.hotels",
        kind: "hotel_group",
        product: "pms",
        resourceType: "pms_hotel",
        relationship: "operator",
      },
    ]);
  });

  it("ignores retired product rows and blocks invalid required ownership", () => {
    const result = parseIdentityOwnershipRows([
      row("pms", "affiliates", { user_id: null, status: "pending" }),
      row("booking", "booking_hotels", { user_id: null, platform_status: "live" }),
      row("booking", "booking_hotels", { id: USER_ID, platform_status: "mystery" }),
      row("marketplace", "hotel_profiles", { status: "mystery" }),
    ]);

    expect(result.owners).toEqual([]);
    expect(result.blockers).toEqual([
      expect.objectContaining({
        code: "INVALID_SOURCE_ROW",
        source: "booking.booking_hotels",
        sourceId: USER_ID,
        message: "status is unsupported",
      }),
      expect.objectContaining({
        code: "INVALID_SOURCE_ROW",
        source: "booking.booking_hotels",
        sourceId: RESOURCE_ID,
        message: "user_id is required for an owned product row",
      }),
    ]);
    expect(JSON.stringify(result.blockers)).not.toContain("mystery");
  });
});

function row(
  sourceDatabase: IdentitySourceRow["sourceDatabase"],
  sourceTable: string,
  overrides: Record<string, unknown> = {},
): IdentitySourceRow {
  return {
    sourceDatabase,
    sourceTable,
    rowOrdinal: 1,
    data: {
      id: RESOURCE_ID,
      user_id: USER_ID,
      name: "Legacy resource",
      created_at: CREATED,
      updated_at: CREATED,
      ...overrides,
    },
  };
}
