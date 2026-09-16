import { createHash } from "node:crypto";
import { PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION } from "@vayada/domain-pms";
import {
  bookingQuoteAcceptanceRequirements,
  parseBookingQuoteAcceptanceInput,
} from "./bookingQuoteAcceptanceInput.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
import { replacementStayKey, type StoredPricingQuote } from "@vayada/domain-booking";
const roomTypeId = "00000000-0000-4000-8000-000000000001",
  revision = "00000000-0000-4000-8000-000000000002";
export function historicalQuoteFixture() {
  const stay = {
    propertyId: "10000000-0000-4000-8000-000000000001",
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
    quoteId: "10000000-0000-4000-8000-000000000002",
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

export function acceptanceFixture() {
  const quote = historicalQuoteFixture();
  const choices = {
    defaultGuestLanguage: "en",
    childrenEnabled: true,
    adultAgeThreshold: 12,
    phoneRequired: false,
    arrivalTimeEnabled: false,
    specialRequestsEnabled: false,
    checkInTime: "15:00",
    checkOutTime: "11:00",
  };
  const disclosure_json = JSON.stringify(
    {
      version: "booking.quote-guest-disclosure.v1",
      quote,
      choices,
      propertyTimeZone: "Europe/Berlin",
    },
    null,
    2,
  );
  const disclosure_hash = `sha256:${hash(disclosure_json)}`;
  const policy = {
    propertyId: quote.stay.propertyId,
    sourceRevision: "guest-policy:1",
    disclosureHash: disclosure_hash,
    choices,
  };
  const requirements = bookingQuoteAcceptanceRequirements(quote, policy)!;
  const { fingerprint, ...command } = parseBookingQuoteAcceptanceInput(
    {
      version: "booking-quote-acceptance.v1",
      requestId: "request-1",
      quoteId: quote.quoteId,
      acceptance: {
        accepted: true,
        quoteEvidenceId: requirements.quoteEvidenceId,
        guestPolicyEvidenceId: requirements.guestPolicyEvidenceId,
      },
      guest: {
        firstName: "Jane",
        lastName: "Guest",
        email: "jane@example.test",
        phone: null,
        countryCode: null,
        arrivalTime: null,
        specialRequests: null,
      },
    },
    quote,
    policy,
  )!;
  return {
    id: "10000000-0000-4000-8000-000000000003",
    property_id: quote.stay.propertyId,
    organization_id: "10000000-0000-4000-8000-000000000004",
    pricing_quote_id: quote.quoteId,
    guest_booking_id: "10000000-0000-4000-8000-000000000005",
    command_receipt_id: "10000000-0000-4000-8000-000000000006",
    request_id: command.requestId,
    key_hash: hash(command.requestId),
    request_fingerprint_hash: fingerprint.slice(7),
    quote_snapshot: quote,
    disclosure_json,
    disclosure_hash,
    guest_policy_source_revision: policy.sourceRevision,
    acceptance_command: command,
    inventory_reservation_bundle: {
      contractVersion: "pms-inventory-reservation-bundle.v1",
      owner: "pms",
      receipts: [
        {
          contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
          owner: "pms",
          receiptId: "10000000-0000-4000-8000-000000000007",
        },
      ],
    },
    billing_plan_snapshot: "fixed",
    commission_terms_snapshot: {
      bookingEngineFeePercent: 5,
      channelManagerFeePercent: 7,
      affiliatePlatformFeePercent: 2,
      financeConfigUpdatedAt: "2026-08-01T00:00:00.000Z",
    },
    finance_terms_captured_at: "2026-09-01T00:01:00.000Z",
    accepted_at: "2026-09-01T00:02:00.000Z",
  };
}
