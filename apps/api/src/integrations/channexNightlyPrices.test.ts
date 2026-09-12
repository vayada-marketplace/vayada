import {
  planChannexOfferConfiguration,
  verifyChannexOfferConfiguration,
  verifyChannexOfferRoom,
} from "./channexOfferConfiguration.js";
import { describe, expect, it, vi } from "vitest";
import type { PricingConfiguration, RoomNightProjectionRequest } from "@vayada/domain-pms";
import { prepareChannexAdultNightPrices } from "./channexNightlyPrices.js";

const request: Omit<RoomNightProjectionRequest, "guests"> = {
  propertyId: "property",
  roomTypeId: "room",
  offerId: "flex",
  expectedRevision: 7,
  expectedTermsRevisions: { flex: "terms7", nr: "terms8" },
  date: "2026-10-15",
};
function fixture(): PricingConfiguration {
  return {
    version: "pricing.v2",
    propertyId: "property",
    roomTypeId: "room",
    revision: 7,
    currency: "EUR",
    capacity: { total: 4, adults: 3, children: 2 },
    children: {
      adultFromAge: 12,
      bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "2000", countsTowardCapacity: true }],
    },
    offers: [
      {
        id: "flex",
        termsRevision: "terms7",
        meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
        price: {
          kind: "independent",
          calendar: {
            base: { mode: "occupancy", amountsMinor: ["10000", "13000", "15500"] },
            months: [],
            seasons: [],
            weekdays: [],
            dates: [],
          },
        },
        restrictions: {
          kind: "own",
          rules: {
            minArrivalNights: 3,
            maxStayNights: 14,
            closedToArrival: true,
            closedToDeparture: true,
            stopSell: true,
          },
          seasons: [],
          dates: [],
        },
      },
      {
        id: "nr",
        termsRevision: "terms8",
        meal: {
          kind: "breakfast",
          charge: { kind: "person", adultMinor: "1000", childBandAmountsMinor: ["500"] },
        },
        price: {
          kind: "linked",
          parentId: "flex",
          adjustment: { kind: "percentage", basisPoints: -1000 },
          dateOverrides: [],
        },
        restrictions: { kind: "inherit" },
      },
    ],
  };
}
function prepare(config = fixture(), input = request) {
  const result = prepareChannexAdultNightPrices(config, input);
  if (result.kind !== "prepared") throw new Error(result.reason);
  return result.candidates;
}
function withBase(base: unknown, currency = "EUR"): PricingConfiguration {
  const c = fixture();
  return {
    ...c,
    currency,
    offers: [
      {
        ...c.offers[0],
        price: {
          kind: "independent",
          calendar: {
            base,
            months: [],
            seasons: [],
            weekdays: [],
            dates: [],
          },
        },
      },
    ],
  } as PricingConfiguration;
}

describe("Channex adult nightly price preparation with real PMS calculator", () => {
  it("retains exact occupancy totals and restricted-night evidence", () => {
    const rows = prepare();
    expect(rows.map(({ occupancy, rate }) => ({ occupancy, rate }))).toEqual([
      { occupancy: 1, rate: "100.00" },
      { occupancy: 2, rate: "130.00" },
      { occupancy: 3, rate: "155.00" },
    ]);
    for (const row of rows) {
      expect(row.projection).toMatchObject({
        kind: "projected",
        propertyId: "property",
        roomTypeId: "room",
        offerId: "flex",
        revision: 7,
        currency: "EUR",
        termsRevisions: { flex: "terms7" },
        guests: { adults: row.occupancy, childAgesAtCheckIn: [] },
        night: {
          date: request.date,
          restrictionOfferId: "flex",
          sources: [{ offerId: "flex", kind: "base" }],
          restrictions: {
            minArrivalNights: 3,
            maxStayNights: 14,
            closedToArrival: true,
            closedToDeparture: true,
            stopSell: true,
          },
        },
      });
    }
  });
  it("uses actual occupancy for meals and retains the linked restriction owner", () => {
    const rows = prepare(fixture(), { ...request, offerId: "nr" });
    expect(rows.map((r) => r.rate)).toEqual(["100.00", "137.00", "169.50"]);
    expect(rows[2].projection).toMatchObject({
      termsRevisions: { flex: "terms7", nr: "terms8" },
      night: {
        roomMinor: "13950",
        mealMinor: "3000",
        totalMinor: "16950",
        restrictionOfferId: "flex",
        sources: [
          { offerId: "flex", kind: "base" },
          { offerId: "nr", kind: "linked" },
        ],
      },
    });
  });
  it("evaluates per-person and included-guest tariffs rather than multiplying room totals", () => {
    expect(prepare(withBase({ mode: "per_person", unitMinor: "6000" })).map((r) => r.rate)).toEqual(
      ["60.00", "120.00", "180.00"],
    );
    expect(
      prepare(
        withBase({
          mode: "included_guests",
          baseGuests: 2,
          baseMinor: "13000",
          adjustments: [
            { kind: "fixed", deltaMinor: "-3000" },
            { kind: "fixed", deltaMinor: "0" },
            { kind: "fixed", deltaMinor: "2500" },
          ],
        }),
      ).map((r) => r.rate),
    ).toEqual(["100.00", "130.00", "155.00"]);
  });
  it.each([
    ["JPY", "123", "123"],
    ["KWD", "1", "0.001"],
    ["EUR", "1", "0.01"],
    ["EUR", "999999999999999999", "9999999999999999.99"],
  ])("formats %s minor amount %s exactly", (currency, amountMinor, decimal) => {
    expect(prepare(withBase({ mode: "flat", amountMinor }, currency)).map((r) => r.rate)).toEqual([
      decimal,
      decimal,
      decimal,
    ]);
  });
  it("preserves exact-date prices and restriction clears without mutating inputs", () => {
    const c = withBase({ mode: "flat", amountMinor: "10000" });
    const first = c.offers[0];
    if (first.price.kind !== "independent" || first.restrictions.kind !== "own")
      throw new Error("fixture");
    const config = {
      ...c,
      offers: [
        {
          ...first,
          price: {
            ...first.price,
            calendar: {
              ...first.price.calendar,
              dates: [
                { date: request.date, price: { mode: "flat" as const, amountMinor: "12000" } },
              ],
            },
          },
          restrictions: {
            ...first.restrictions,
            dates: [
              {
                date: request.date,
                rules: {
                  minArrivalNights: 1,
                  maxStayNights: null,
                  closedToArrival: false,
                  closedToDeparture: false,
                  stopSell: false,
                },
              },
            ],
          },
        },
      ],
    };
    const before = structuredClone(config);
    const row = prepare(config)[0];
    expect(row.rate).toBe("120.00");
    expect(row.projection.night).toMatchObject({
      sources: [{ offerId: "flex", kind: "date" }],
      restrictions: config.offers[0].restrictions.dates[0].rules,
    });
    expect(config).toEqual(before);
  });
  it.each([
    [{ propertyId: "other" }, "invalid_request"],
    [{ roomTypeId: "other" }, "invalid_request"],
    [{ expectedRevision: 6 }, "stale"],
    [{ expectedTermsRevisions: { flex: "old" } }, "stale"],
    [{ expectedTermsRevisions: {} }, "missing_terms"],
    [{ offerId: "missing" }, "missing_price"],
    [{ date: "2026-02-30" }, "invalid_request"],
  ])("fails explicitly for invalid or stale owner evidence %j", (patch, reason) => {
    expect(prepareChannexAdultNightPrices(fixture(), { ...request, ...patch })).toEqual({
      kind: "unavailable",
      reason,
    });
  });
  it("returns no partial rows when a later occupancy overflows", () => {
    const c = withBase({ mode: "per_person", unitMinor: "500000000000000000" });
    expect(prepareChannexAdultNightPrices(c, request)).toEqual({
      kind: "unavailable",
      reason: "overflow",
    });
  });
  it("rejects invalid or missing prices without fallback", () => {
    expect(prepareChannexAdultNightPrices({}, request)).toEqual({
      kind: "unavailable",
      reason: "invalid_configuration",
    });
    expect(prepareChannexAdultNightPrices(withBase(null), request)).toEqual({
      kind: "unavailable",
      reason: "missing_price",
    });
  });
  it("bounds local candidate work without truncating an oversized room", () => {
    const c = withBase({ mode: "flat", amountMinor: "10000" });
    expect(
      prepareChannexAdultNightPrices(
        { ...c, capacity: { total: 101, adults: 101, children: 0 } },
        request,
      ),
    ).toEqual({ kind: "unavailable", reason: "candidate_limit" });
  });
});

describe("closed Channex offer configuration", () => {
  function adultRoom() {
    return { ...fixture(), capacity: { total: 3, adults: 3, children: 0 } };
  }
  it.each(["room_only", "breakfast", "half_board", "full_board", "all_inclusive"] as const)(
    "preserves %s identity and explicit primary without price or markup",
    (kind) => {
      const room = adultRoom();
      const offer = {
        ...room.offers[0],
        meal: { kind, charge: { kind: "room" as const, amountMinor: "0" } },
      };
      const result = planChannexOfferConfiguration({ ...room, offers: [offer] }, "flex", 2);
      expect(result).toEqual({
        kind: "planned",
        configuration: {
          sell_mode: "per_person",
          rate_mode: "manual",
          parent_rate_plan_id: null,
          inherit_rate: false,
          currency: "EUR",
          meal_type: kind,
          options: [
            { occupancy: 1, is_primary: false },
            { occupancy: 2, is_primary: true },
            { occupancy: 3, is_primary: false },
          ],
          stop_sell: Array(7).fill(true),
        },
      });
    },
  );
  it("materializes linked offers independently without provider derivation", () => {
    expect(planChannexOfferConfiguration(adultRoom(), "nr", 3)).toMatchObject({
      kind: "planned",
      configuration: {
        meal_type: "breakfast",
        rate_mode: "manual",
        parent_rate_plan_id: null,
        inherit_rate: false,
      },
    });
  });
  it("rejects unsupported children, invalid selection and oversized plans without partial output", () => {
    expect(planChannexOfferConfiguration(fixture(), "flex", 1)).toEqual({
      kind: "unavailable",
      reason: "child_representation_unavailable",
    });
    expect(planChannexOfferConfiguration(adultRoom(), "missing", 1)).toEqual({
      kind: "unavailable",
      reason: "selection_unavailable",
    });
    for (const primary of [0, 4, 1.5, NaN])
      expect(planChannexOfferConfiguration(adultRoom(), "flex", primary)).toEqual({
        kind: "unavailable",
        reason: "invalid_primary_occupancy",
      });
    expect(planChannexOfferConfiguration({}, "flex", 1)).toEqual({
      kind: "unavailable",
      reason: "invalid_configuration",
    });
    expect(
      planChannexOfferConfiguration(
        {
          ...withBase({ mode: "flat", amountMinor: "10000" }),
          capacity: { adults: 101, total: 101, children: 0 },
        },
        "flex",
        1,
      ),
    ).toEqual({ kind: "unavailable", reason: "candidate_limit" });
  });
});

describe("closed offer configuration readback", () => {
  const identity = {
    externalPropertyId: "property",
    externalRoomTypeId: "room",
    externalRatePlanId: "rate",
  };
  function setup() {
    const base = fixture();
    const room = { ...base, capacity: { ...base.capacity, children: 0 } };
    const planned = planChannexOfferConfiguration(room, "flex", 2);
    if (planned.kind !== "planned") throw new Error(planned.reason);
    const response = {
      data: {
        id: "rate",
        attributes: {
          ...structuredClone(planned.configuration),
          property_id: "property",
          room_type_id: "room",
          inherit_stop_sell: false,
          auto_rate_settings: null,
          options: planned.configuration.options.map((option) => ({
            ...option,
            derived_option: null,
            rate: "100.00",
          })),
        },
      },
    };
    const request = vi.fn(async () => response);
    return { room, response, request, planned };
  }
  it("verifies one GET and accepts reordered options without claiming amounts", async () => {
    const { room, response, request, planned } = setup();
    response.data.attributes.options.reverse();
    expect(await verifyChannexOfferConfiguration(room, "flex", 2, identity, request)).toEqual({
      ...identity,
      mealType: "room_only",
      configuration: planned.configuration,
    });
    expect(request.mock.calls).toEqual([["GET", "/api/v1/rate_plans/rate"]]);
  });
  it.each([
    ["sell_mode", "per_room"],
    ["rate_mode", "derived"],
    ["currency", "USD"],
    ["inherit_rate", true],
    ["inherit_stop_sell", true],
    ["auto_rate_settings", {}],
    ["parent_rate_plan_id", "parent"],
    ["parent_rate_plan_id", undefined],
    ["stop_sell", [true]],
    ["stop_sell", [true, true, true, true, true, true, false]],
    ["stop_sell", Array(7).fill("true")],
    ["stop_sell", undefined],
    ["stop_sell", Array(7)],
    ["inherit_rate", undefined],
    ["inherit_stop_sell", undefined],
    ["auto_rate_settings", undefined],
    ["options", []],
    ["options", null],
    ["meal_type", "breakfast"],
    ["property_id", "other"],
    ["room_type_id", "other"],
    ["id", "other"],
  ])("rejects changed or absent %s", async (key, value) => {
    const { room, response, request } = setup();
    (response.data.attributes as Record<string, unknown>)[key as string] = value;
    await expect(
      verifyChannexOfferConfiguration(room, "flex", 2, identity, request),
    ).rejects.toThrow();
  });
  it.each([
    "duplicate",
    "extra",
    "missing",
    "primary",
    "derived",
    "unknown_derivation",
    "string_occupancy",
  ])("rejects %s options", async (kind) => {
    const { room, response, request } = setup();
    const options = response.data.attributes.options;
    if (kind === "duplicate") options[0] = options[1];
    if (kind === "extra") options.push({ ...options[0], occupancy: 4 });
    if (kind === "missing") options.pop();
    if (kind === "primary") options[0].is_primary = true;
    if (kind === "derived") Object.assign(options[0], { derived_option: {} });
    if (kind === "unknown_derivation") Object.assign(options[0], { derived_option: undefined });
    if (kind === "string_occupancy") Object.assign(options[0], { occupancy: "1" });
    await expect(
      verifyChannexOfferConfiguration(room, "flex", 2, identity, request),
    ).rejects.toThrow();
  });
  it("rejects conflicting relationships and wrong rate IDs", async () => {
    for (const patch of [
      { id: "other" },
      { relationships: { property: { data: { id: "other" } } } },
      { relationships: { parent_rate_plan: { data: { id: "parent" } } } },
    ]) {
      const { room, response, request } = setup();
      Object.assign(response.data, patch);
      await expect(
        verifyChannexOfferConfiguration(room, "flex", 2, identity, request),
      ).rejects.toThrow();
    }
  });
  it("accepts explicit absent-parent relationship evidence", async () => {
    const { room, response, request } = setup();
    Object.assign(response.data.attributes, { parent_rate_plan_id: undefined });
    Object.assign(response.data, { relationships: { parent_rate_plan: { data: null } } });
    await expect(
      verifyChannexOfferConfiguration(room, "flex", 2, identity, request),
    ).resolves.toMatchObject(identity);
  });
  it("propagates failed transport without returning evidence", async () => {
    const { room } = setup();
    await expect(
      verifyChannexOfferConfiguration(room, "flex", 2, identity, async () => {
        throw new Error("transport unavailable");
      }),
    ).rejects.toThrow("transport unavailable");
  });
  it("rejects unsupported configuration before IO", async () => {
    const { request } = setup();
    await expect(
      verifyChannexOfferConfiguration(fixture(), "flex", 2, identity, request),
    ).rejects.toThrow("child_representation_unavailable");
    expect(request).not.toHaveBeenCalled();
  });
  it("snapshots expectations before asynchronous IO", async () => {
    const { room, response, planned } = setup();
    const mutableIdentity = { ...identity };
    const result = await verifyChannexOfferConfiguration(
      room,
      "flex",
      2,
      mutableIdentity,
      async () => {
        mutableIdentity.externalRatePlanId = "other";
        room.currency = "USD";
        Object.assign(room.offers[0].meal, { kind: "breakfast" });
        return response;
      },
    );
    expect(result).toEqual({
      ...identity,
      mealType: "room_only",
      configuration: planned.configuration,
    });
  });
});

describe("Channex published adult room preflight", () => {
  const identity = { externalPropertyId: "property", externalRoomTypeId: "room/encoded" };
  function setup() {
    const base = fixture(),
      room = { ...base, capacity: { ...base.capacity, children: 0 } };
    const response = {
      data: {
        type: "room_type",
        id: identity.externalRoomTypeId,
        attributes: {
          id: identity.externalRoomTypeId,
          property_id: identity.externalPropertyId,
          room_kind: "room",
          capacity: null,
          occ_adults: 3,
          occ_children: 0,
          occ_infants: 0,
          default_occupancy: 2,
        },
      },
    };
    const request = vi.fn(async () => response);
    return { room, response, request };
  }
  it("verifies exact identity/capacity with one GET without choosing a rate primary", async () => {
    const { room, response, request } = setup();
    const expected = { ...identity, adults: 3, children: 0, infants: 0, roomKind: "room" };
    expect(await verifyChannexOfferRoom(room, identity, request)).toEqual(expected);
    expect(request.mock.calls).toEqual([["GET", "/api/v1/room_types/room%2Fencoded"]]);
    response.data.attributes.default_occupancy = 1;
    expect(await verifyChannexOfferRoom(room, identity, request)).toEqual(expected);
  });
  it("accepts relationship-only property identity and rejects contradictions", async () => {
    const { room, response, request } = setup();
    Object.assign(response.data, { relationships: { property: { data: { id: "property" } } } });
    Object.assign(response.data.attributes, { property_id: undefined });
    await expect(verifyChannexOfferRoom(room, identity, request)).resolves.toMatchObject(identity);
    response.data.attributes.property_id = "other";
    await expect(verifyChannexOfferRoom(room, identity, request)).rejects.toThrow();
    response.data.attributes.property_id = "property";
    Object.assign(response.data, { relationships: { property: { data: { id: "other" } } } });
    await expect(verifyChannexOfferRoom(room, identity, request)).rejects.toThrow();
  });
  it.each([
    ["id", "other"],
    ["property_id", "other"],
    ["property_id", undefined],
    ["room_kind", "dorm"],
    ["room_kind", undefined],
    ["capacity", 3],
    ["capacity", undefined],
    ["occ_adults", 2],
    ["occ_adults", 4],
    ["occ_adults", "3"],
    ["occ_adults", undefined],
    ["occ_children", 1],
    ["occ_children", undefined],
    ["occ_children", "0"],
    ["occ_infants", 1],
    ["occ_infants", undefined],
  ])("rejects mismatched or missing %s", async (key, value) => {
    const { room, response, request } = setup();
    (response.data.attributes as Record<string, unknown>)[key as string] = value;
    await expect(verifyChannexOfferRoom(room, identity, request)).rejects.toThrow();
  });
  it("rejects wrong resource identity and malformed responses", async () => {
    const { room, response } = setup();
    for (const body of [
      null,
      {},
      { data: [] },
      { data: { ...response.data, id: "other" } },
      { data: { ...response.data, type: "rate_plan" } },
      { data: { ...response.data, relationships: { property: { data: null } } } },
    ]) {
      await expect(verifyChannexOfferRoom(room, identity, async () => body)).rejects.toThrow();
    }
  });
  it("rejects unsupported local inputs before IO", async () => {
    const { room, request } = setup();
    for (const invalid of [null, {}, fixture()])
      await expect(verifyChannexOfferRoom(invalid, identity, request)).rejects.toThrow();
    for (const invalid of ["", " ", " room "])
      await expect(
        verifyChannexOfferRoom(room, { ...identity, externalRoomTypeId: invalid }, request),
      ).rejects.toThrow();
    await expect(
      verifyChannexOfferRoom(room, { ...identity, externalPropertyId: "" }, request),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("retains expected identity and capacity despite caller mutation during IO", async () => {
    const { room, response } = setup(),
      mutable = { ...identity };
    expect(
      await verifyChannexOfferRoom(room, mutable, async () => {
        mutable.externalPropertyId = "other";
        mutable.externalRoomTypeId = "other";
        room.capacity.adults = 10;
        return response;
      }),
    ).toEqual({ ...identity, adults: 3, children: 0, infants: 0, roomKind: "room" });
  });
  it("propagates transport failures without evidence", async () => {
    const { room } = setup();
    await expect(
      verifyChannexOfferRoom(room, identity, async () => {
        throw new Error("room unavailable");
      }),
    ).rejects.toThrow("room unavailable");
  });
});
