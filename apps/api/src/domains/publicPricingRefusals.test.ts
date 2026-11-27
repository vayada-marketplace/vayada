import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PricingConfiguration } from "@vayada/domain-pms";
import type { PoolClient } from "pg";

const publication = vi.hoisted(() => vi.fn());
vi.mock("./publicPricingPublication.js", () => ({ lockPublicPricingPublication: publication }));

import { lockPublicPricingMinimumStays } from "./publicPricingRefusals.js";
import { publicPricingOfferKey } from "./publicPricingRoomStay.js";

const PROPERTY = "33333333-3333-4333-8333-333333333333";
const DOUBLE = "44444444-4444-4444-8444-444444444444";
const rules = {
  minArrivalNights: 1,
  maxStayNights: null,
  closedToArrival: false,
  closedToDeparture: false,
  stopSell: false,
};
const offer = (
  id: string,
  arrival: Partial<typeof rules>,
  later: { date: string; rules: typeof rules }[] = [],
) => ({
  id,
  termsRevision: `terms-${id}`,
  meal: { kind: "room_only", charge: { kind: "room", amountMinor: "0" } },
  price: {
    kind: "independent",
    calendar: {
      base: { mode: "flat", amountMinor: "10000" },
      months: [],
      seasons: [],
      weekdays: [],
      dates: [],
    },
  },
  restrictions: {
    kind: "own",
    rules,
    seasons: [],
    dates: [{ date: "2026-12-10", rules: { ...rules, ...arrival } }, ...later],
  },
});
const room = {
  version: "pricing.v2",
  propertyId: PROPERTY,
  roomTypeId: DOUBLE,
  revision: 1,
  currency: "EUR",
  capacity: { total: 2, adults: 2, children: 0 },
  children: {
    adultFromAge: 12,
    bands: [{ fromAge: 0, throughAge: 11, nightlyMinor: "0", countsTowardCapacity: true }],
  },
  offers: [
    offer("flex", { minArrivalNights: 3 }),
    offer("closed", { closedToArrival: true }),
    offer("open", {}),
    // Two nights from this arrival, but the second night is stop-sell: two nights don't sell either.
    offer("stopped", { minArrivalNights: 2 }, [
      { date: "2026-12-11", rules: { ...rules, stopSell: true } },
    ]),
  ],
} as unknown as PricingConfiguration;
const key = (offerId: string) => publicPricingOfferKey("pms-1", DOUBLE, offerId);
const client = {} as PoolClient;
const dates = { checkIn: "2026-12-10", checkOut: "2026-12-11" };
const couple = { adults: 2, childAges: [] };

beforeEach(() => {
  publication.mockReset().mockResolvedValue({
    scope: { propertyId: PROPERTY, organizationId: "org" },
    pmsSourceRevision: "pms-1",
    publication: { rooms: [room] },
  });
});

describe("lockPublicPricingMinimumStays (VAY-2613)", () => {
  it("names the minimum stay from the arrival that refuses each rate, as the quote applies it", async () => {
    const minimum = await lockPublicPricingMinimumStays(client, "hotel", dates, [
      { publicOfferKey: key("flex"), guests: couple },
      { publicOfferKey: key("closed"), guests: couple },
      { publicOfferKey: key("open"), guests: couple },
      { publicOfferKey: key("stopped"), guests: couple },
      { publicOfferKey: "pricing-offer.v2:unknown", guests: couple },
    ]);
    // Closed to arrival, priced, refused at the minimum stay too, or no longer published: no
    // minimum stay to name.
    expect([...minimum]).toEqual([[key("flex"), 3]]);
    expect(publication).toHaveBeenCalledWith(client, "hotel");
  });

  it("names none once the stay is long enough, or without a publication", async () => {
    const long = await lockPublicPricingMinimumStays(
      client,
      "hotel",
      { checkIn: "2026-12-10", checkOut: "2026-12-13" },
      [{ publicOfferKey: key("flex"), guests: couple }],
    );
    expect(long.size).toBe(0);
    publication.mockResolvedValueOnce(null);
    const none = await lockPublicPricingMinimumStays(client, "hotel", dates, [
      { publicOfferKey: key("flex"), guests: couple },
    ]);
    expect(none.size).toBe(0);
  });
});
