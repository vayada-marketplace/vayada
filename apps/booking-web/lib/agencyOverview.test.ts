import { describe, expect, it } from "vitest";
import { agencyResults, formatStayRange, stayHref, stayNights } from "./agencyOverview";
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
});
const stays = ["mertha", "escape", "mandala", "uma", "wiswan", "dewari"].map(stay);
const priced = (id: string, nightly: number, currency = "USD"): AgencyStayPrice => ({
  propertyId: id,
  status: "available",
  rooms: 1,
  roomTypesFree: 2,
  price: { total: nightly * 2, nightly, currency, promoApplied: false },
  nextFree: null,
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

describe("stayHref", () => {
  const search = {
    checkIn: "2026-11-12",
    checkOut: "2026-11-14",
    adults: 4,
    children: 1,
    rooms: 1,
    promoCode: "AUTUMN",
  };

  it("opens the stay's own address with the search on a booking host", () => {
    expect(
      stayHref(
        { protocol: "https:", host: "the-travel-ubud.next-booking.vayada.com", pathname: "/de" },
        "the-travel-ubud",
        "escape-villa",
        search,
        { rooms: 2, promoApplied: true },
      ),
    ).toBe(
      "https://escape-villa.next-booking.vayada.com/de?checkIn=2026-11-12&checkOut=2026-11-14&adults=4&children=1&rooms=2&promoCode=AUTUMN",
    );
  });

  it("leaves out one room and a code the stay doesn't take", () => {
    expect(
      stayHref(
        { protocol: "http:", host: "the-travel-ubud.booking.localhost:3002", pathname: "/" },
        "the-travel-ubud",
        "uma",
        search,
        { rooms: 1, promoApplied: false },
      ),
    ).toBe(
      "http://uma.booking.localhost:3002/?checkIn=2026-11-12&checkOut=2026-11-14&adults=4&children=1",
    );
  });

  it("uses ?slug= on a development host", () => {
    expect(
      stayHref(
        { protocol: "http:", host: "localhost:3002", pathname: "/" },
        "the-travel-ubud",
        "uma",
        { ...search, rooms: 2 },
        null,
      ),
    ).toBe("/?checkIn=2026-11-12&checkOut=2026-11-14&adults=4&children=1&rooms=2&slug=uma");
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
