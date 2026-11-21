import { beforeEach, expect, it, vi } from "vitest";

// VAY-2583: when guests can pay for none of the published rates, the catalog says so (200 with no
// rooms and a reason) instead of answering "not found", which the booking page showed as "We can't
// show our rooms right now. Please try again".
const scope = { propertyId: "25830000-0000-4000-8000-000000000001", organizationId: "org" };
const mocks = vi.hoisted(() => ({
  publication: vi.fn(),
  authority: vi.fn(),
  coverage: vi.fn(),
  methods: vi.fn(),
  mapped: vi.fn(),
  operating: vi.fn(),
}));
vi.mock("./publicPricingPublication.js", () => ({ lockPublicPricingPublication: mocks.publication }));
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

let live = true;
const queries: string[] = [];
const pool = {
  connect: async () => ({
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: /active_public_booking_revision/.test(sql) && live ? [{ "?column?": 1 }] : [] };
    },
    release: () => undefined,
  }),
};
const read = () => createPublicPricingOfferCatalog(pool as never).read("aether-hilltop-villas");
const noWayToPay = {
  version: "public-pricing-offers.v1",
  rooms: [],
  unavailable: "no_payment_method",
};
const rate = { roomName: "Villa One", cancellation: "flexible", acceptedMethods: ["pay_at_property"] };

beforeEach(() => {
  vi.clearAllMocks();
  live = true;
  queries.length = 0;
  mocks.authority.mockResolvedValue(scope);
});

it("says no way to pay is left when nothing is served because no rate can be paid (VAY-2583)", async () => {
  mocks.publication.mockResolvedValue(null);
  mocks.coverage.mockResolvedValue({ rates: [{ ...rate, payableWith: [] }], payable: 0 });
  await expect(read()).resolves.toEqual(noWayToPay);
  expect(mocks.coverage).toHaveBeenCalledWith(expect.anything(), scope.propertyId, expect.anything());
  // The transaction was still open while the reason was read.
  expect(queries.at(-1)).toBe("ROLLBACK");
});

it("stays not found when a rate can be paid, the page isn't live, or the slug is unknown", async () => {
  mocks.publication.mockResolvedValue(null);
  // Payable, so this is another reason (a refresh still on its way): not found, as before.
  mocks.coverage.mockResolvedValue({
    rates: [{ ...rate, payableWith: ["pay_at_property"] }],
    payable: 1,
  });
  await expect(read()).resolves.toBeNull();
  // Nothing published yet.
  mocks.coverage.mockResolvedValue(null);
  await expect(read()).resolves.toBeNull();
  // A booking page that isn't live never gets the reason.
  live = false;
  mocks.coverage.mockResolvedValue({ rates: [{ ...rate, payableWith: [] }], payable: 0 });
  await expect(read()).resolves.toBeNull();
  live = true;
  mocks.authority.mockResolvedValue(null);
  await expect(read()).resolves.toBeNull();
  expect(mocks.coverage).toHaveBeenCalledTimes(3);
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
  mocks.methods.mockReturnValue(new Map([["flex", []], ["flex-2", []]]));
  await expect(read()).resolves.toEqual(noWayToPay);
  // Changed hands while reading (the recheck sees another owner): not the reason, not found.
  mocks.authority.mockResolvedValueOnce({ ...scope, organizationId: "other" });
  await expect(read()).resolves.toBeNull();
  // No operating room at all is not about payment: not found, as before.
  mocks.authority.mockResolvedValue(scope);
  mocks.operating.mockResolvedValue([{ roomTypeId: "villa-one", state: "retired" }]);
  await expect(read()).resolves.toBeNull();
});
