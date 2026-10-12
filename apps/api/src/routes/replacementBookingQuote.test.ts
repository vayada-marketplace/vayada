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
});
