import { beforeEach, expect, it, vi } from "vitest";

// VAY-2583: when guests can pay for none of the published rates, the booking page's own catalog
// read says so (no rooms and a reason) instead of answering "not found", which the page showed as
// "We can't show our rooms right now. Please try again". Other readers keep "not found".
const scope = { propertyId: "25830000-0000-4000-8000-000000000001", organizationId: "org" };
const mocks = vi.hoisted(() => ({
  publication: vi.fn(),
  authority: vi.fn(),
  coverage: vi.fn(),
  methods: vi.fn(),
  mapped: vi.fn(),
  operating: vi.fn(),
}));
vi.mock("./publicPricingPublication.js", () => ({
  lockPublicPricingPublication: mocks.publication,
}));
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: mocks.authority }));
vi.mock("./pricingRatePaymentCoverage.js", () => ({ readRatePaymentCoverage: mocks.coverage }));
vi.mock("./pmsRoomOperatingEligibility.js", () => ({
  readPmsRoomOperatingEligibility: mocks.operating,
}));
vi.mock("./replacementPublicOfferMapping.js", () => ({
  mapReplacementPublicOffers: mocks.mapped,
  publicOfferCancellations: () => new Map(),
  publicOfferMealDescriptions: () => new Map(),
  publicOfferPaymentMethods: mocks.methods,
  publicOfferPaymentSchedules: () => new Map(),
}));

const { createPublicPricingOfferCatalog } = await import("./publicPricingOfferCatalog.js");

const queries: string[] = [];
const pool = {
  connect: async () => ({
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: /active_public_booking_revision/.test(sql) ? [{ "?column?": 1 }] : [] };
    },
    release: () => undefined,
  }),
};
const catalog = createPublicPricingOfferCatalog(pool as never);
const forGuests = () => catalog.readForGuests("aether-hilltop-villas");
const noWayToPay = {
  version: "public-pricing-offers.v1",
  rooms: [],
  unavailable: "no_payment_method",
};
const rate = {
  roomName: "Villa One",
  cancellation: "flexible",
  acceptedMethods: ["pay_at_property"],
};
const unpayable = (financeReason: string | null) => ({
  rates: [{ ...rate, payableWith: [] }],
  payable: 0,
  settings: { paymentsEnabled: true, acceptedMethods: ["card"] },
  financeReason,
});

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  mocks.authority.mockResolvedValue(scope);
});

it("says no way to pay is left when nothing is served because no rate can be paid (VAY-2583)", async () => {
  mocks.publication.mockResolvedValue(null);
  // Card on but not ready and pay at hotel off: Finance has no way to pay at all.
  mocks.coverage.mockResolvedValue(unpayable("method_unavailable"));
  await expect(forGuests()).resolves.toEqual(noWayToPay);
  expect(mocks.coverage).toHaveBeenCalledWith(
    expect.anything(),
    scope.propertyId,
    expect.anything(),
  );
  // The transaction was still open while the reason was read.
  expect(queries.at(-1)).toBe("ROLLBACK");
  // Payments off is a payment reason too.
  mocks.coverage.mockResolvedValue(unpayable("payments_disabled"));
  await expect(forGuests()).resolves.toEqual(noWayToPay);
  // Each answer is its own object.
  const [first, second] = [await forGuests(), await forGuests()];
  expect(first).not.toBe(second);
  // The room cards' prices and agency pages read "not found", as before.
  await expect(catalog.read("aether-hilltop-villas")).resolves.toBeNull();
});

it("stays not found when a rate can be paid, for other reasons, or without a live page", async () => {
  mocks.publication.mockResolvedValue(null);
  // Payable: another reason (a refresh still on its way).
  mocks.coverage.mockResolvedValue({
    ...unpayable(null),
    rates: [{ ...rate, payableWith: ["pay_at_property"] }],
    payable: 1,
  });
  await expect(forGuests()).resolves.toBeNull();
  // Finance out for a reason that isn't about paying (currency, settings): not the payment message.
  for (const reason of ["currency_mismatch", "settings_missing", "invalid"]) {
    mocks.coverage.mockResolvedValue(unpayable(reason));
    await expect(forGuests()).resolves.toBeNull();
  }
  // Not live, or nothing published (the coverage says nothing), or an unknown slug.
  mocks.coverage.mockResolvedValue(null);
  await expect(forGuests()).resolves.toBeNull();
  mocks.authority.mockResolvedValue(null);
  await expect(forGuests()).resolves.toBeNull();
});

it("says no way to pay is left when every operating room's rates are filtered out by payment (VAY-2583)", async () => {
  mocks.publication.mockResolvedValue({ scope });
  mocks.mapped.mockReturnValue([
    { roomTypeId: "villa-one", offers: [{ ratePlanId: "flex" }] },
    { roomTypeId: "villa-two", offers: [{ ratePlanId: "flex-2" }] },
  ]);
  mocks.operating.mockResolvedValue([
    { roomTypeId: "villa-one", state: "operating" },
    { roomTypeId: "villa-two", state: "operating" },
  ]);
  // Every rate takes only pay at the hotel, which is off: no way to pay any of them.
  mocks.methods.mockReturnValue(
    new Map([
      ["flex", []],
      ["flex-2", []],
    ]),
  );
  await expect(forGuests()).resolves.toEqual(noWayToPay);
  await expect(catalog.read("aether-hilltop-villas")).resolves.toBeNull();
  // Changed hands while reading (the recheck sees another owner): not the reason, not found.
  mocks.authority.mockResolvedValueOnce({ ...scope, organizationId: "other" });
  await expect(forGuests()).resolves.toBeNull();
  // No operating room at all is not about payment: not found, as before.
  mocks.operating.mockResolvedValue([{ roomTypeId: "villa-one", state: "retired" }]);
  await expect(forGuests()).resolves.toBeNull();
});
