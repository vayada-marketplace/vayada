import { describe, expect, it, vi } from "vitest";
import { PricingStorageError } from "../domains/replacementPricingStore.js";
import { createReplacementBookingQuoteIssuer } from "./replacementBookingQuote.js";

const selection = {
  version: "public-pricing-selection.v1",
  checkIn: "2026-10-01",
  checkOut: "2026-10-02",
  currency: "EUR",
  rooms: [
    {
      selectionId: "one",
      publicOfferKey: "offer",
      guests: { adults: 1, childAgesAtCheckIn: [] },
    },
  ],
  addons: [],
  promoCode: null,
};
const request = (paymentMethod: string) => ({
  version: "public-booking-quote-request.v1",
  selection,
  paymentMethod,
});

describe("replacement booking quote issuer", () => {
  it("quotes bank transfer and PayPal only when acceptance can take them", async () => {
    // The store answering "stale" proves the request reached it without building a full quote.
    const issue = vi.fn().mockRejectedValue(new PricingStorageError("stale"));
    const off = createReplacementBookingQuoteIssuer({ issue });
    const on = createReplacementBookingQuoteIssuer({ issue }, ["paypal", "bank_transfer"]);
    for (const method of ["bank_transfer", "paypal"]) {
      await expect(off("hotel", request(method), "key")).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(issue).not.toHaveBeenCalled();
      await expect(on("hotel", request(method), "key")).rejects.toMatchObject({
        statusCode: 409,
        code: "QUOTE_REFRESH_REQUIRED",
      });
      expect(issue).toHaveBeenLastCalledWith(
        "hotel",
        expect.objectContaining({ requestId: "key", paymentMethod: method }),
        undefined,
      );
      issue.mockClear();
    }
    for (const method of ["cash", "manual_card", "xendit"])
      await expect(on("hotel", request(method), "key")).rejects.toMatchObject({ statusCode: 400 });
    // Without the bank-details binding only PayPal is quoted.
    const paypalOnly = createReplacementBookingQuoteIssuer({ issue }, ["paypal"]);
    await expect(paypalOnly("hotel", request("bank_transfer"), "key")).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(issue).not.toHaveBeenCalled();
  });

  it("tells the guest when check-in is too close for bank transfer or PayPal (VAY-2145)", async () => {
    const issue = vi
      .fn()
      .mockRejectedValue(new PricingStorageError("denied", "manual_payment_too_soon"));
    const on = createReplacementBookingQuoteIssuer({ issue }, ["paypal", "bank_transfer"]);
    await expect(on("hotel", request("bank_transfer"), "key")).rejects.toMatchObject({
      statusCode: 422,
      code: "MANUAL_PAYMENT_TOO_SOON",
    });
    // Any other refusal stays "Quote unavailable".
    issue.mockRejectedValue(new PricingStorageError("denied"));
    await expect(on("hotel", request("paypal"), "key")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("quotes part now by card, the rest at the property, only with deposits on (VAY-2205)", async () => {
    const deposit = {
      kind: "deposit",
      basisPoints: 3000,
      balanceDaysBeforeArrival: 0,
      acceptedMethods: ["card"],
    };
    const stored = (dueNowMinor: string, dueLaterMinor: string) => ({
      quote: {
        quoteId: "11111111-1111-4111-8111-111111111111",
        paymentMethod: "card",
        acceptanceMode: "instant",
        stay: {
          checkIn: selection.checkIn,
          checkOut: selection.checkOut,
          currency: "EUR",
          rooms: [{ selectionId: "one", roomTypeId: "room", offerId: "flex" }],
        },
        evidence: {
          issuedAt: "2026-09-01T08:00:00.000Z",
          expiresAt: "2026-09-01T08:05:00.000Z",
          totalMinor: "10000",
          dueNowMinor,
          dueLaterMinor,
          lines: [{ kind: "room", selectionId: "one", amountMinor: "10000" }],
          terms: [
            {
              roomTypeId: "room",
              offerId: "flex",
              cancellation: { kind: "non_refundable" },
              payment: deposit,
            },
          ],
        },
        rooms: [{ selectionId: "one", mealPlan: "room_only" }],
      },
      replayed: false,
    });
    const issue = vi.fn().mockResolvedValue(stored("3000", "7000"));
    const off = createReplacementBookingQuoteIssuer({ issue });
    const on = createReplacementBookingQuoteIssuer({ issue }, [], undefined, true);
    await expect(off("hotel", request("card"), "key")).rejects.toMatchObject({
      statusCode: 422,
      code: "CARD_DEPOSIT_UNAVAILABLE",
    });
    await expect(on("hotel", request("card"), "key")).resolves.toMatchObject({
      totalMinor: "10000",
      dueNowMinor: "3000",
      dueLaterMinor: "7000",
      rooms: [{ selectionId: "one", payment: deposit }],
    });
    // A card stay paid in full needs no switch.
    issue.mockResolvedValue(stored("10000", "0"));
    await expect(off("hotel", request("card"), "key")).resolves.toMatchObject({
      dueNowMinor: "10000",
    });
  });

  it("tells the guest when an extra needs more notice than the stay gives (VAY-2232)", async () => {
    const issue = vi.fn().mockRejectedValue(new PricingStorageError("denied", "addon_lead_time"));
    const on = createReplacementBookingQuoteIssuer({ issue }, []);
    await expect(on("hotel", request("card"), "key")).rejects.toMatchObject({
      statusCode: 422,
      code: "ADDON_NEEDS_NOTICE",
    });
  });

  it("refuses new quotes with extras or a code the hotel switched off in Feature Hub (VAY-2200)", async () => {
    const issue = vi.fn().mockRejectedValue(new PricingStorageError("stale"));
    const switches = { addOns: false, promoCodes: false };
    const guestModules = vi.fn(async () => switches);
    const quote = createReplacementBookingQuoteIssuer({ issue }, [], guestModules);
    const withSelection = (extra: Record<string, unknown>) => ({
      ...request("card"),
      selection: { ...selection, ...extra },
    });
    const extras = { addons: [{ id: "breakfast", quantity: 1, dates: null }] };

    // A plain stay never reads the switches.
    await expect(quote("hotel", request("card"), "key")).rejects.toMatchObject({ statusCode: 409 });
    expect(guestModules).not.toHaveBeenCalled();

    await expect(quote("hotel", withSelection(extras), "key")).rejects.toMatchObject({
      statusCode: 422,
      code: "ADDONS_UNAVAILABLE",
    });
    await expect(
      quote("hotel", withSelection({ promoCode: "SUMMER" }), "key"),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "PROMO_CODES_UNAVAILABLE",
    });
    expect(guestModules).toHaveBeenCalledWith("hotel");
    expect(issue).toHaveBeenCalledTimes(1);

    switches.addOns = true;
    switches.promoCodes = true;
    await expect(
      quote("hotel", withSelection({ ...extras, promoCode: "SUMMER" }), "key"),
    ).rejects.toMatchObject({ statusCode: 409, code: "QUOTE_REFRESH_REQUIRED" });
    expect(issue).toHaveBeenCalledTimes(2);

    // A failed switch read is a temporary outage, not a refusal; a hidden hotel stays a 404.
    guestModules.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(quote("hotel", withSelection(extras), "key")).rejects.toMatchObject({
      statusCode: 503,
    });
    guestModules.mockRejectedValueOnce(Object.assign(new Error("not found"), { statusCode: 404 }));
    await expect(quote("hotel", withSelection(extras), "key")).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(issue).toHaveBeenCalledTimes(2);
  });
});
