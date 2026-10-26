import { afterEach, expect, it, vi } from "vitest";
import {
  chosenRatesPaymentMethods,
  displayQuoteMoney,
  getReplacementCatalog,
  getReplacementOffers,
  roomQuoteRequest,
  type PricingRoom,
} from "./replacementOffers";
const key = `pricing-offer.v2:${"a".repeat(64)}`;
const rooms: PricingRoom[] = [
  {
    roomTypeId: "suite",
    name: "Suite",
    offers: [{ publicOfferKey: key, currency: "EUR", mealPlan: "breakfast" }],
  },
];
const choices = () => [
  { selectionId: "one", publicOfferKey: key, adults: "2", childAges: ["0", "7"] },
  { selectionId: "two", publicOfferKey: key, adults: "1", childAges: [] },
];
const make = (choice = choices(), catalog = rooms) =>
  roomQuoteRequest(catalog, choice, "2026-10-01", "2026-10-03", "pay_at_property");
afterEach(() => vi.unstubAllGlobals());
it("preserves explicit infant age and distinct physical rooms with the same offer", () => {
  expect(make()?.selection.rooms).toEqual([
    { selectionId: "one", publicOfferKey: key, guests: { adults: 2, childAgesAtCheckIn: [0, 7] } },
    { selectionId: "two", publicOfferKey: key, guests: { adults: 1, childAgesAtCheckIn: [] } },
  ]);
});
it("rejects unknown ages, malformed adults, missing offers and duplicate selections", () => {
  for (const age of ["", "-1", "18", "1.5", " 0"])
    expect(make([{ ...choices()[0], childAges: [age] }])).toBeNull();
  for (const adults of ["", "0", "-1", "1.5", "100"])
    expect(make([{ ...choices()[0], adults }])).toBeNull();
  expect(make([{ ...choices()[0], publicOfferKey: "old-rate" }])).toBeNull();
  expect(make([choices()[0], choices()[0]])).toBeNull();
  expect(make([])).toBeNull();
  expect(make(choices(), [...rooms, ...rooms])).toBeNull();
});
it("rejects mixed currencies, impossible dates and reversed stays", () => {
  const second = {
    publicOfferKey: `pricing-offer.v2:${"b".repeat(64)}`,
    currency: "USD",
    mealPlan: "room_only" as const,
  };
  expect(
    make(
      [choices()[0], { ...choices()[1], publicOfferKey: second.publicOfferKey }],
      [{ ...rooms[0], offers: [...rooms[0].offers, second] }],
    ),
  ).toBeNull();
  for (const [start, end] of [
    ["2026-02-30", "2026-03-03"],
    ["2026-10-03", "2026-10-01"],
    ["2026-01-01", "2028-01-01"],
  ])
    expect(roomQuoteRequest(rooms, choices(), start, end, "card")).toBeNull();
});
it("loads current keys from the same-origin no-store catalogue and rejects ambiguous content", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ version: "public-pricing-offers.v1", rooms })),
    );
  vi.stubGlobal("fetch", fetcher);
  expect(await getReplacementOffers("a/b")).toEqual(rooms);
  expect(fetcher).toHaveBeenCalledWith("/api/booking-web/hotels/a%2Fb/pricing-offers", {
    signal: undefined,
    cache: "no-store",
  });
  for (const bad of [
    { version: "old", rooms },
    { version: "public-pricing-offers.v1", rooms: [...rooms, ...rooms] },
    {
      version: "public-pricing-offers.v1",
      rooms: [{ ...rooms[0], offers: [{ ...rooms[0].offers[0], publicOfferKey: "old" }] }],
    },
  ]) {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(bad)));
    await expect(getReplacementOffers("hotel")).rejects.toThrow("verified");
  }
});
it("formats accounting units without float rounding or ICU zero-decimal shortcuts", () => {
  expect(displayQuoteMoney("9007199254740993", "EUR")).toBe("EUR 90071992547409.93");
  expect(displayQuoteMoney("1", "JPY")).toBe("JPY 1");
  expect(displayQuoteMoney("1", "KWD")).toBe("KWD 0.001");
  expect(displayQuoteMoney("10800", "IDR")).toBe("IDR 108");
  expect(displayQuoteMoney("150000000", "IDR")).toBe("IDR 1500000");
  expect(displayQuoteMoney("150000050", "IDR")).toBe("IDR 1500001"); // half-up display only
});

it("sends the entered promo with the exact selection and clears it explicitly", () => {
  const request = (code: string) =>
    roomQuoteRequest(rooms, choices(), "2026-10-01", "2026-10-03", "card", code);
  expect(request(" SAVE10 ")?.selection.promoCode).toBe("SAVE10");
  expect(request(" ")?.selection.promoCode).toBeNull();
  expect(request("x".repeat(201))).toBeNull();
});

it("keeps the room cards' content and drops malformed parts without failing selection", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        version: "public-pricing-offers.v1",
        rooms: [
          {
            ...rooms[0],
            description: "Our quietest room.",
            occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
            images: [
              { url: "https://images.vayada.com/room.jpg", alt: "Garden view" },
              { url: "javascript:alert(1)", alt: "x" },
              { url: "https://images.vayada.com/two.jpg", alt: "" },
            ],
            size: { value: 32, unit: "sqm" },
            category: "Double",
            amenities: ["Free WiFi", "", 3],
            offers: [
              {
                ...rooms[0].offers[0],
                cancellation: { kind: "free_until_days_before_arrival", days: 3 },
                mealDescription: "Buffet breakfast in the Stube",
              },
            ],
          },
          {
            roomTypeId: "loft",
            name: "Loft",
            description: 7,
            occupancy: { maxGuests: 0 },
            size: { value: 30, unit: "sqft" },
            offers: [
              {
                publicOfferKey: `pricing-offer.v2:${"c".repeat(64)}`,
                currency: "EUR",
                mealPlan: "room_only",
                cancellation: { kind: "free_until_days_before_arrival", days: -1 },
                mealDescription: "   ",
              },
            ],
          },
        ],
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(await getReplacementOffers("hotel")).toEqual([
    {
      ...rooms[0],
      description: "Our quietest room.",
      occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
      images: [
        { url: "https://images.vayada.com/room.jpg", alt: "Garden view" },
        { url: "https://images.vayada.com/two.jpg", alt: null },
      ],
      size: { value: 32, unit: "sqm" },
      category: "Double",
      amenities: ["Free WiFi"],
      offers: [
        {
          ...rooms[0].offers[0],
          cancellation: { kind: "free_until_days_before_arrival", days: 3 },
          mealDescription: "Buffet breakfast in the Stube",
        },
      ],
    },
    {
      roomTypeId: "loft",
      name: "Loft",
      offers: [
        {
          publicOfferKey: `pricing-offer.v2:${"c".repeat(64)}`,
          currency: "EUR",
          mealPlan: "room_only",
        },
      ],
    },
  ]);
});

it("reads the location map and each room's pin, dropping a pin out of range (VAY-2126)", async () => {
  // Offer keys are unique across the catalog.
  const offers = (digit: string) => [
    {
      publicOfferKey: `pricing-offer.v2:${digit.repeat(64)}`,
      currency: "EUR",
      mealPlan: "room_only",
    },
  ];
  const catalog = (body: Record<string, unknown>) =>
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ version: "public-pricing-offers.v1", ...body })),
        ),
    );
  catalog({
    locationMap: { property: { latitude: 48.14, longitude: 11.58, approximate: true } },
    rooms: [
      {
        ...rooms[0],
        location: { latitude: 48.15634, longitude: 11.58242, address: "Leopoldstraße 12" },
      },
      {
        roomTypeId: "loft",
        name: "Loft",
        offers: offers("b"),
        location: { latitude: 91, longitude: 11.5 },
      },
      {
        roomTypeId: "studio",
        name: "Studio",
        offers: offers("c"),
        location: { latitude: "48", longitude: 11.5 },
      },
    ],
  });
  expect(await getReplacementCatalog("hotel")).toEqual({
    locationMap: { property: { latitude: 48.14, longitude: 11.58, approximate: true } },
    rooms: [
      {
        ...rooms[0],
        location: { latitude: 48.15634, longitude: 11.58242, address: "Leopoldstraße 12" },
      },
      { roomTypeId: "loft", name: "Loft", offers: offers("b") },
      { roomTypeId: "studio", name: "Studio", offers: offers("c") },
    ],
  });
  catalog({ rooms, locationMap: { property: { latitude: 120, longitude: 11.58 } } });
  expect(await getReplacementCatalog("hotel")).toEqual({ rooms, locationMap: { property: null } });
  catalog({ rooms });
  expect(await getReplacementCatalog("hotel")).toEqual({ rooms, locationMap: null });
});

it("reads where each room is: at the property, or an area without its street (VAY-2321)", async () => {
  const offers = (digit: string) => [
    {
      publicOfferKey: `pricing-offer.v2:${digit.repeat(64)}`,
      currency: "EUR",
      mealPlan: "room_only",
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: "public-pricing-offers.v1",
          locationMap: { property: null },
          rooms: [
            { ...rooms[0], atProperty: true, showMapInDetails: true },
            {
              roomTypeId: "villa",
              name: "Villa",
              offers: offers("b"),
              atProperty: false,
              showMapInDetails: false,
              // An area never carries a street, even if one were sent.
              location: {
                latitude: 6.02,
                longitude: 80.27,
                approximate: true,
                area: "Ahangama",
                address: "Galle Road 1",
              },
            },
            { roomTypeId: "loft", name: "Loft", offers: offers("c"), atProperty: "yes" },
          ],
        }),
      ),
    ),
  );
  expect((await getReplacementCatalog("hotel")).rooms).toEqual([
    { ...rooms[0], atProperty: true, showMapInDetails: true },
    {
      roomTypeId: "villa",
      name: "Villa",
      offers: offers("b"),
      atProperty: false,
      showMapInDetails: false,
      location: { latitude: 6.02, longitude: 80.27, approximate: true, area: "Ahangama" },
    },
    { roomTypeId: "loft", name: "Loft", offers: offers("c") },
  ]);
});

it("reads each rate's ways to pay and the ways all chosen rates take (VAY-2309)", async () => {
  const card = `pricing-offer.v2:${"d".repeat(64)}`;
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        version: "public-pricing-offers.v1",
        rooms: [
          {
            ...rooms[0],
            offers: [
              { ...rooms[0].offers[0], paymentMethods: ["card", "pay_at_property"] },
              {
                publicOfferKey: card,
                currency: "EUR",
                mealPlan: "room_only",
                paymentMethods: ["card"],
              },
              {
                publicOfferKey: `pricing-offer.v2:${"e".repeat(64)}`,
                currency: "EUR",
                mealPlan: "room_only",
                paymentMethods: ["card", "cash"],
              },
            ],
          },
        ],
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const read = await getReplacementOffers("hotel");
  expect(read[0]!.offers.map((offer) => offer.paymentMethods)).toEqual([
    ["card", "pay_at_property"],
    ["card"],
    // A way to pay the page doesn't know: the rate's ways stay unknown.
    undefined,
  ]);
  const chosen = (...keys: string[]) =>
    chosenRatesPaymentMethods(
      read,
      keys.map((publicOfferKey, index) => ({
        selectionId: String(index),
        publicOfferKey,
        adults: "1",
        childAges: [],
      })),
    );
  expect(chosen(key)).toEqual(["card", "pay_at_property"]);
  expect(chosen(key, card)).toEqual(["card"]);
  expect(chosen(key, `pricing-offer.v2:${"e".repeat(64)}`)).toBeNull();
  expect(chosen("pricing-offer.v2:unknown")).toBeNull();
  // An older API without the field: unknown.
  expect(chosenRatesPaymentMethods(rooms, choices())).toBeNull();
});
