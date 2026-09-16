import {
  bookingQuoteAcceptanceRequirements,
  parseBookingQuoteAcceptanceInput,
} from "./bookingQuoteAcceptanceInput.js";
import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { replacementStayKey, type StoredPricingQuote } from "@vayada/domain-booking";
import { lockCurrentQuoteGuestDisclosure } from "./currentQuoteGuestDisclosure.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { lockCurrentGuestChoiceRevision } from "./bookingGuestChoiceStore.js";
import { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
vi.mock("./publicPricingAuthority.js", () => ({ lockPublicPricingAuthority: vi.fn() }));
vi.mock("./bookingGuestChoiceStore.js", () => ({ lockCurrentGuestChoiceRevision: vi.fn() }));
vi.mock("./currentQuoteRevalidation.js", () => ({ lockCurrentQuoteRevalidation: vi.fn() }));
const roomTypeId = "00000000-0000-4000-8000-000000000001",
  revision = "00000000-0000-4000-8000-000000000002";
function fixture() {
  const stay = {
    propertyId: "hotel",
    checkIn: "2026-10-01",
    checkOut: "2026-10-03",
    currency: "EUR",
    rooms: [
      {
        selectionId: "one",
        roomTypeId,
        offerId: "flex",
        guests: { adults: 2, childAgesAtCheckIn: [8] },
      },
    ],
    addons: [],
    promoCode: null,
  };
  return {
    version: "stored-pricing-quote.v1",
    quoteId: "quote-1",
    evaluatorVersion: "booking.1",
    paymentMethod: "card",
    stay,
    evidence: {
      version: "pricing.v2",
      requestKey: replacementStayKey(stay),
      currency: "EUR",
      revisions: {
        pms: "p1",
        terms: "t1",
        promotions: "pr1",
        addons: "a1",
        charges: "c1",
        finance: "f1",
        fx: "x1",
      },
      issuedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-01T00:15:00.000Z",
      lines: [
        { id: "r", selectionId: "one", kind: "room", amountMinor: "30000" },
        { id: "m", selectionId: "one", kind: "meal", amountMinor: "6000" },
      ],
      totalMinor: "36000",
      dueNowMinor: "10800",
      dueLaterMinor: "25200",
      terms: [
        {
          roomTypeId,
          offerId: "flex",
          revision,
          cancellation: { kind: "non_refundable" },
          payment: { kind: "deposit", basisPoints: 3000, balanceDaysBeforeArrival: 7 },
        },
      ],
      fx: [],
      paymentCapabilityEvidenceId: "finance",
      mandatoryChargeEvidenceId: "charges",
    },
    rooms: [
      {
        selectionId: "one",
        configurationRevision: 2,
        termsRevisions: { flex: revision },
        mealPlan: "breakfast",
        nights: ["2026-10-01", "2026-10-02"].map((date) => ({
          date,
          roomMinor: "15000",
          mealMinor: "3000",
          totalMinor: "18000",
          sources: [{ offerId: "flex", kind: "base" }],
        })),
      },
    ],
  } satisfies StoredPricingQuote;
}

const client = {} as PoolClient;
const scope = { propertyId: "hotel", organizationId: "org", authorityRevision: "authority:1" };
const choices = {
  defaultGuestLanguage: "en" as const,
  childrenEnabled: true,
  adultAgeThreshold: 18,
  phoneRequired: true,
  arrivalTimeEnabled: true,
  specialRequestsEnabled: true,
  checkInTime: "15:00",
  checkOutTime: "11:00",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(lockPublicPricingAuthority).mockResolvedValue(scope);
  vi.mocked(lockCurrentGuestChoiceRevision).mockResolvedValue({
    propertyId: "hotel",
    sourceRevision: "guest-policy:confirmed-1",
    choices: { ...choices },
  });
  vi.mocked(lockCurrentQuoteRevalidation).mockResolvedValue({
    quote: fixture(),
    scope,
    checkedAt: "2026-09-01T00:01:00.000Z",
    sameDay: { propertyTimeZone: "Europe/Berlin" },
  } as never);
});
it("binds exact replacement quote, confirmed guest choices and current timezone after owner locks", async () => {
  const result = await lockCurrentQuoteGuestDisclosure(client, "hotel", "quote-1");
  expect(result).not.toBeNull();
  expect(result!.disclosure.quote).toEqual(fixture());
  expect(result!.disclosure.choices).toEqual(choices);
  expect(result!.disclosure.propertyTimeZone).toBe("Europe/Berlin");
  expect(JSON.parse(result!.disclosureJson)).toEqual(result!.disclosure);
  expect(result!.policy.disclosureHash).toBe(
    "sha256:" + createHash("sha256").update(result!.disclosureJson).digest("hex"),
  );
  expect(lockCurrentGuestChoiceRevision).toHaveBeenCalledWith(client, "hotel", "org");
  expect(lockCurrentQuoteRevalidation).toHaveBeenCalledWith(client, "hotel", "quote-1");
  expect(vi.mocked(lockPublicPricingAuthority).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(lockCurrentGuestChoiceRevision).mock.invocationCallOrder[0],
  );
  expect(vi.mocked(lockCurrentGuestChoiceRevision).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(lockCurrentQuoteRevalidation).mock.invocationCallOrder[0],
  );
});
it("denies absent public authority, absent confirmed choices and a stale quote", async () => {
  vi.mocked(lockPublicPricingAuthority).mockResolvedValueOnce(null);
  expect(await lockCurrentQuoteGuestDisclosure(client, "hotel", "quote-1")).toBeNull();
  expect(lockCurrentGuestChoiceRevision).not.toHaveBeenCalled();
  vi.mocked(lockCurrentGuestChoiceRevision).mockResolvedValueOnce(null);
  expect(await lockCurrentQuoteGuestDisclosure(client, "hotel", "quote-1")).toBeNull();
  expect(lockCurrentQuoteRevalidation).not.toHaveBeenCalled();
  vi.mocked(lockCurrentQuoteRevalidation).mockResolvedValueOnce(null);
  expect(await lockCurrentQuoteGuestDisclosure(client, "hotel", "quote-1")).toBeNull();
});
it("changes disclosure identity when replacement quote terms change and denies owner changes", async () => {
  const original = await lockCurrentQuoteGuestDisclosure(client, "hotel", "quote-1");
  const quote = fixture();
  quote.evidence.terms[0].payment.basisPoints = 4000;
  vi.mocked(lockCurrentQuoteRevalidation).mockResolvedValueOnce({
    quote,
    scope,
    checkedAt: "2026-09-01T00:01:00.000Z",
    sameDay: { propertyTimeZone: "Europe/Berlin" },
  } as never);
  const updated = await lockCurrentQuoteGuestDisclosure(client, "hotel", "quote-1");
  expect(updated).not.toBeNull();
  expect(updated!.policy.disclosureHash).not.toBe(original!.policy.disclosureHash);
  expect(updated!.quoteEvidenceId).not.toBe(original!.quoteEvidenceId);
  vi.mocked(lockCurrentQuoteRevalidation).mockResolvedValueOnce({
    quote,
    scope: { ...scope, organizationId: "other" },
  } as never);
  expect(await lockCurrentQuoteGuestDisclosure(client, "hotel", "quote-1")).toBeNull();
});
it("rejects scope mismatches and requires renewed acknowledgment for changed choices or confirmation", async () => {
  const original = await lockCurrentQuoteGuestDisclosure(client, "hotel", "quote-1");
  for (const change of [
    { sourceRevision: "guest-policy:confirmed-2" },
    { choices: { ...choices, phoneRequired: false } },
  ]) {
    vi.mocked(lockCurrentGuestChoiceRevision).mockResolvedValueOnce({
      propertyId: "hotel",
      sourceRevision: "guest-policy:confirmed-1",
      choices,
      ...change,
    });
    const updated = await lockCurrentQuoteGuestDisclosure(client, "hotel", "quote-1");
    expect(updated!.guestPolicyEvidenceId).not.toBe(original!.guestPolicyEvidenceId);
  }
  vi.mocked(lockCurrentGuestChoiceRevision).mockResolvedValueOnce({
    propertyId: "another",
    sourceRevision: "guest-policy:1",
    choices,
  });
  expect(await lockCurrentQuoteGuestDisclosure(client, "hotel", "quote-1")).toBeNull();
});

it.each([
  { enabled: true, threshold: 12, ages: [11, 12, 17], allowed: true },
  { enabled: false, threshold: 12, ages: [12, 17], allowed: true },
  { enabled: false, threshold: 12, ages: [11, 12, 17], allowed: false },
  { enabled: false, threshold: null, ages: [17], allowed: false },
  { enabled: false, threshold: null, ages: [], allowed: true },
])(
  "classifies actual ages without rewriting immutable quote evidence: %j",
  ({ enabled, threshold, ages, allowed }) => {
    const quote = fixture();
    quote.stay.rooms[0].guests.childAgesAtCheckIn = ages;
    quote.evidence.requestKey = replacementStayKey(quote.stay);
    const original = structuredClone(quote);
    const policy = {
      propertyId: quote.stay.propertyId,
      sourceRevision: "guest-policy:age-rule",
      disclosureHash: "sha256:" + "a".repeat(64),
      choices: { ...choices, childrenEnabled: enabled, adultAgeThreshold: threshold },
    };
    const requirements = bookingQuoteAcceptanceRequirements(quote, policy)!;
    expect(requirements).not.toBeNull();
    const input = {
      version: "booking-quote-acceptance.v1",
      requestId: "request",
      quoteId: quote.quoteId,
      acceptance: {
        accepted: true,
        quoteEvidenceId: requirements.quoteEvidenceId,
        guestPolicyEvidenceId: requirements.guestPolicyEvidenceId,
      },
      guest: {
        firstName: "Test",
        lastName: "Guest",
        email: "test@example.com",
        phone: "+1234567",
        countryCode: null,
        arrivalTime: null,
        specialRequests: null,
      },
    };
    const result = parseBookingQuoteAcceptanceInput(input, quote, policy);
    expect(result !== null).toBe(allowed);
    expect(quote).toEqual(original);
    expect(requirements.quote.stay.rooms[0].guests.childAgesAtCheckIn).toEqual(ages);
  },
);
