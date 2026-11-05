import { describe, expect, it } from "vitest";
import {
  agencyFilterOptions,
  agencyResults,
  formatStayRange,
  localePrefix,
  nearbyStays,
  NO_FILTERS,
  overviewHref,
  stayHref,
  stayNights,
  type AgencyFilters,
} from "./agencyOverview";
import type { AgencyStay, AgencyStayPrice, AgencyStayPrices } from "@/services/api/agencyPage";

const stay = (id: string): AgencyStay => ({
  propertyId: id,
  slug: `${id}-ubud`,
  name: id,
  propertyType: "villa",
  area: "Ubud",
  photoUrl: null,
  photos: [],
  childrenEnabled: true,
  privatePool: false,
  map: null,
  units: null,
});
const stays = ["mertha", "escape", "mandala", "uma", "wiswan", "dewari"].map(stay);
const priced = (id: string, nightly: number, currency = "USD"): AgencyStayPrice => ({
  propertyId: id,
  status: "available",
  rooms: 1,
  roomTypesFree: 2,
  price: { total: nightly * 2, nightly, currency, promoApplied: false },
  nextFree: null,
  rateFilters: { breakfast: null, freeCancellation: null, both: null },
});
const answer = (list: AgencyStayPrice[]): AgencyStayPrices => ({
  checkIn: "2026-11-12",
  checkOut: "2026-11-14",
  childrenPriced: true,
  stays: list,
});
const read = answer([
  priced("mertha", 38),
  priced("escape", 95),
  priced("mandala", 55),
  { ...priced("uma", 0), status: "unavailable", price: null, roomTypesFree: 0 },
  { ...priced("wiswan", 0), status: "unknown", price: null, roomTypesFree: 0 },
  { ...priced("dewari", 0), status: "no_fit", price: null, roomTypesFree: 0 },
]);
const options = { badge: true, comparable: (amount: number) => amount };
const ids = (cards: { stay: AgencyStay }[]) => cards.map((card) => card.stay.propertyId);

describe("agencyResults", () => {
  it("lists every stay in the page's order, without prices, before the search answers", () => {
    const results = agencyResults(stays, null, "price_low", options);
    expect(ids(results.cards)).toEqual(ids(stays.map((s) => ({ stay: s }))));
    expect(results.cards.every((card) => card.price === null && !card.lowest)).toBe(true);
    expect(results.full).toEqual([]);
  });

  it("puts the cheapest first, unread stays after, and full stays apart", () => {
    const results = agencyResults(stays, read, "price_low", options);
    expect(ids(results.cards)).toEqual(["mertha", "mandala", "escape", "wiswan"]);
    expect(results.cards.map((card) => card.lowest)).toEqual([true, false, false, false]);
    expect(ids(results.full)).toEqual(["uma", "dewari"]);
    expect([results.available, results.total]).toEqual([3, 6]);
  });

  it("sorts by the highest price, or keeps the page's order for Recommended", () => {
    expect(ids(agencyResults(stays, read, "price_high", options).cards)).toEqual([
      "escape",
      "mandala",
      "mertha",
      "wiswan",
    ]);
    const recommended = agencyResults(stays, read, "recommended", options);
    expect(ids(recommended.cards)).toEqual(["mertha", "escape", "mandala", "wiswan"]);
    // The badge still marks the cheapest stay.
    expect(recommended.cards.find((card) => card.lowest)?.stay.propertyId).toBe("mertha");
  });

  it("compares prices in other currencies once converted, and leaves out what can't be", () => {
    const mixed = answer([
      priced("mertha", 38),
      priced("escape", 30, "EUR"),
      priced("mandala", 500_000, "IDR"),
    ]);
    const toUsd = (amount: number, currency: string) =>
      currency === "USD" ? amount : currency === "EUR" ? amount * 2 : null;
    const results = agencyResults(stays, mixed, "price_low", { ...options, comparable: toUsd });
    // IDR has no rate: it keeps its card and price, after the compared stays, without the badge.
    expect(ids(results.cards)).toEqual(["mertha", "escape", "mandala"]);
    expect(results.cards.map((card) => card.lowest)).toEqual([true, false, false]);
    const cheaper = answer([priced("mertha", 38), priced("mandala", 100, "IDR")]);
    const none = agencyResults(stays, cheaper, "price_low", { ...options, comparable: toUsd });
    // One compared stay is no "lowest".
    expect(none.cards.some((card) => card.lowest)).toBe(false);
  });

  it("compares one currency as it is, with no rates at all", () => {
    const idr = answer([priced("mertha", 900_000, "IDR"), priced("escape", 500_000, "IDR")]);
    const results = agencyResults(stays, idr, "price_low", { ...options, comparable: () => null });
    expect(ids(results.cards)).toEqual(["escape", "mertha"]);
    expect(results.cards[0]!.lowest).toBe(true);
  });

  it("shows no badge when it's off, or for a single priced stay", () => {
    expect(
      agencyResults(stays, read, "price_low", { ...options, badge: false }).cards.some(
        (card) => card.lowest,
      ),
    ).toBe(false);
    const one = answer([priced("mertha", 38), { ...priced("escape", 0), price: null }]);
    expect(agencyResults(stays, one, "price_low", options).cards.some((c) => c.lowest)).toBe(false);
  });

  it("leaves out a stay the answer no longer has (it stopped being public)", () => {
    const results = agencyResults(stays, answer([priced("escape", 95)]), "price_low", options);
    expect(ids(results.cards)).toEqual(["escape"]);
    expect(results.total).toBe(1);
  });
});

describe("filters (VAY-2460)", () => {
  // Villas in Ubud with pools, a guest house, a resort in Peliatan, a villa in Penestanan.
  const facts: Record<string, Partial<AgencyStay>> = {
    mertha: { propertyType: "guesthouse" },
    escape: { privatePool: true },
    mandala: { propertyType: "resort", area: "Peliatan" },
    uma: { privatePool: true },
    wiswan: { area: "Penestanan" },
  };
  const all = stays.map((one) => ({ ...one, ...facts[one.propertyId] }));
  const rates = (filters: Partial<NonNullable<AgencyStayPrice["rateFilters"]>>) => ({
    breakfast: null,
    freeCancellation: null,
    both: null,
    ...filters,
  });
  const at = (nightly: number) => ({
    roomTypesFree: 1,
    price: { total: nightly * 2, nightly, currency: "USD", promoApplied: false },
  });
  // Breakfast at Mertha and The Escape; free cancellation only at The Escape.
  const answered = answer(
    read.stays.map((price) =>
      price.propertyId === "mertha"
        ? { ...price, rateFilters: rates({ breakfast: at(45) }) }
        : price.propertyId === "escape"
          ? {
              ...price,
              rateFilters: rates({ breakfast: at(120), freeCancellation: at(100), both: at(130) }),
            }
          : price,
    ),
  );
  const filtered = (
    filters: Partial<AgencyFilters>,
    sort: "price_low" | "recommended" = "price_low",
  ) =>
    agencyResults(all, answered, sort, {
      ...options,
      filters: { ...NO_FILTERS, ...filters },
      priceValue: (amount, currency) => (currency === "USD" ? amount : null),
    });

  it("narrows every list by type, area and private pool, and counts what is left", () => {
    const villas = filtered({ type: "villa" });
    expect(ids(villas.cards)).toEqual(["escape", "wiswan"]);
    expect(ids(villas.full)).toEqual(["uma", "dewari"]);
    expect([villas.available, villas.total]).toEqual([1, 4]);
    // A single priced stay gets no badge.
    expect(villas.cards.some((card) => card.lowest)).toBe(false);
    expect(ids(filtered({ area: "Peliatan" }).cards)).toEqual(["mandala"]);
    const pools = filtered({ privatePool: true });
    expect([ids(pools.cards), ids(pools.full)]).toEqual([["escape"], ["uma"]]);
  });

  it("prices each card with only breakfast or free-cancellation rates, and drops the others", () => {
    const breakfast = filtered({ breakfast: true });
    expect(ids(breakfast.cards)).toEqual(["mertha", "escape"]);
    expect(breakfast.cards.map((card) => card.price?.price?.nightly)).toEqual([45, 120]);
    expect(breakfast.cards.map((card) => card.lowest)).toEqual([true, false]);
    expect(breakfast.cards[0]!.price!.roomTypesFree).toBe(1);
    // Full stays don't have rates for the dates: rate filters leave them be.
    expect(ids(breakfast.full)).toEqual(["uma", "dewari"]);
    expect([breakfast.available, breakfast.total]).toEqual([2, 6]);
    const both = filtered({ breakfast: true, freeCancellation: true });
    expect(both.cards.map((card) => [card.stay.propertyId, card.price?.price?.nightly])).toEqual([
      ["escape", 130],
    ]);
  });

  it("keeps the prices per night within the range, and a stay it can't compare", () => {
    expect(ids(filtered({ price: { min: 50, max: 100 } }).cards)).toEqual([
      "mandala",
      "escape",
      "wiswan",
    ]);
    expect(ids(filtered({ price: { min: null, max: 40 } }).cards)).toEqual(["mertha", "wiswan"]);
    // With breakfast, The Escape costs 120.
    expect(ids(filtered({ breakfast: true, price: { min: 100, max: null } }).cards)).toEqual([
      "escape",
    ]);
    const idr = answer([priced("mertha", 38), priced("escape", 900_000, "IDR")]);
    const results = agencyResults(all, idr, "price_low", {
      ...options,
      filters: { ...NO_FILTERS, price: { min: null, max: 40 } },
      priceValue: (amount, currency) => (currency === "USD" ? amount : null),
    });
    expect(ids(results.cards)).toEqual(["mertha", "escape"]);
  });

  it("offers only the chips the agency switched on, while they split the stays", () => {
    const enabled = {
      propertyType: true,
      area: true,
      price: true,
      privatePool: true,
      breakfast: true,
      freeCancellation: true,
      bedrooms: true,
    };
    const value = (amount: number) => amount;
    expect(agencyFilterOptions(all, answered, enabled, NO_FILTERS, value)).toEqual({
      // Most stays first.
      types: ["villa", "guesthouse", "resort"],
      areas: ["Ubud", "Peliatan", "Penestanan"],
      privatePool: true,
      breakfast: true,
      freeCancellation: true,
      price: { min: 38, max: 95 },
    });
    const off = { ...enabled, area: false, privatePool: false, freeCancellation: false };
    expect(agencyFilterOptions(all, answered, off, NO_FILTERS, value)).toMatchObject({
      areas: [],
      privatePool: false,
      freeCancellation: false,
    });
    // Before the search answers there are no rates or prices to split by.
    expect(agencyFilterOptions(all, null, enabled, NO_FILTERS, value)).toMatchObject({
      breakfast: false,
      freeCancellation: false,
      price: null,
    });
    // One type, one area, a pool everywhere, breakfast at every available stay: nothing splits.
    const alike = stays.map((one) => ({ ...one, privatePool: true }));
    const everywhere = answer(
      read.stays.map((price) => ({ ...price, rateFilters: rates({ breakfast: at(50) }) })),
    );
    expect(agencyFilterOptions(alike, everywhere, enabled, NO_FILTERS, value)).toMatchObject({
      types: [],
      areas: [],
      privatePool: false,
      breakfast: false,
    });
    // A chip in use stays, so it can be undone.
    expect(
      agencyFilterOptions(alike, everywhere, enabled, { ...NO_FILTERS, breakfast: true }, value)
        .breakfast,
    ).toBe(true);
  });
});

describe("stay links (VAY-2461)", () => {
  const search = {
    checkIn: "2026-11-12",
    checkOut: "2026-11-14",
    adults: 4,
    children: 1,
    rooms: 1,
    promoCode: "AUTUMN",
  };
  const agencyHost = {
    protocol: "https:",
    host: "the-travel-ubud.next-booking.vayada.com",
    pathname: "/de",
  };

  it("opens the stay's page on the agency's address, in the guest's language, with the search", () => {
    expect(
      stayHref(agencyHost, "the-travel-ubud", "escape-villa", search, {
        rooms: 2,
        promoApplied: true,
      }),
    ).toBe(
      "/de/stays/escape-villa?checkIn=2026-11-12&checkOut=2026-11-14&adults=4&children=1&rooms=2&agencyRooms=1&promoCode=AUTUMN",
    );
  });

  it("leaves out one room, and keeps a code the stay doesn't take as the agency's", () => {
    expect(
      stayHref(
        { protocol: "http:", host: "the-travel-ubud.booking.localhost:3002", pathname: "/" },
        "the-travel-ubud",
        "uma",
        search,
        { rooms: 1, promoApplied: false },
      ),
    ).toBe(
      "/stays/uma?checkIn=2026-11-12&checkOut=2026-11-14&adults=4&children=1&agencyPromo=AUTUMN",
    );
  });

  it("keeps the agency with ?slug= on a development host", () => {
    expect(
      stayHref(
        { protocol: "http:", host: "localhost:3002", pathname: "/" },
        "the-travel-ubud",
        "uma",
        { ...search, rooms: 2 },
        null,
      ),
    ).toBe(
      "/stays/uma?checkIn=2026-11-12&checkOut=2026-11-14&adults=4&children=1&rooms=2&agencyPromo=AUTUMN&slug=the-travel-ubud",
    );
  });

  it("goes back to all stays with the same search", () => {
    expect(
      overviewHref(
        { host: agencyHost.host, pathname: "/de/stays/escape-villa" },
        "the-travel-ubud",
        "?checkIn=2026-11-12&adults=2",
      ),
    ).toBe("/de?checkIn=2026-11-12&adults=2");
    expect(
      overviewHref({ host: "localhost:3002", pathname: "/stays/uma" }, "the-travel-ubud", ""),
    ).toBe("/?slug=the-travel-ubud");
    expect(localePrefix("/stays/uma")).toBe("");
    expect(localePrefix("/fr/stays/uma")).toBe("/fr");
  });
});

describe("nearby stays (VAY-2461)", () => {
  const at = (id: string, latitude: number | null, approximate = false): AgencyStay => ({
    ...stay(id),
    map: latitude === null ? null : { latitude, longitude: 115.26, approximate },
  });
  const names = (list: { stay: AgencyStay }[]) => list.map((one) => one.stay.propertyId);

  it("lists the page's other stays closest first, those without a pin after, at most 8", () => {
    const here = at("escape", -8.5);
    const page = [
      at("far", -8.7),
      here,
      at("unpinned", null),
      at("near", -8.501),
      at("area", -8.52, true),
      ...Array.from({ length: 8 }, (_, i) => at(`more-${i}`, -8.53 - i * 0.01)),
    ];
    const nearby = nearbyStays(page, here);
    expect(nearby).toHaveLength(8);
    expect(names(nearby).slice(0, 3)).toEqual(["near", "area", "more-0"]);
    expect(nearby[0]!.metres).toBeGreaterThan(100);
    expect(nearby[0]!.metres).toBeLessThan(120);
    // Measured to a spot rounded to its area: said as approximate.
    expect(nearby[1]!.approximate).toBe(true);
    expect(names(nearbyStays(page, here, 20)).slice(-2)).toEqual(["far", "unpinned"]);
  });

  it("keeps the page's order when the stay itself has no pin", () => {
    const here = at("escape", null);
    const page = [at("b", -8.6), here, at("a", -8.5)];
    expect(nearbyStays(page, here).map((one) => [one.stay.propertyId, one.metres])).toEqual([
      ["b", null],
      ["a", null],
    ]);
  });
});

describe("dates", () => {
  it("says a stay's dates as a short range", () => {
    expect(formatStayRange("2026-11-12", "2026-11-14", "en")).toMatch(/^12\s–\s14 Nov$/);
    expect(formatStayRange("2026-11-30", "2026-12-02", "en")).toMatch(/^30 Nov\s–\s2 Dec$/);
    expect(stayNights("2026-11-12", "2026-11-14")).toBe(2);
    expect(stayNights("2026-03-28", "2026-03-30")).toBe(2);
  });
});
