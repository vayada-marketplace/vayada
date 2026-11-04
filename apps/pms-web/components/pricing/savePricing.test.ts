import { describe, expect, it } from "vitest";
import { ApiErrorResponse } from "@/services/api/client";
import { english } from "./pricingAmounts";
import { financeNotReady, noPricingAccess, pricingSaveError } from "./savePricing";

const denied = (reason: string) => new ApiErrorResponse(403, { code: "denied", reason } as never);

describe("a refused price save when payments aren't ready (VAY-2383)", () => {
  it("says the prices were not saved and what to set up first, never that the edits are kept", () => {
    for (const reason of [
      "settings_missing",
      "payments_disabled",
      "currency_mismatch",
      "method_unavailable",
    ]) {
      const text = pricingSaveError(denied(reason), english);
      expect(financeNotReady(denied(reason))).toBe(true);
      expect(text).toContain("not saved");
      expect(text).toContain("Booking Admin");
      expect(text).not.toContain("kept");
    }
    expect(pricingSaveError(denied("settings_missing"), english)).toContain("Settings → Payments");
    expect(pricingSaveError(denied("settings_missing"), english)).toContain(
      "Settings → General → Localization",
    );
  });

  it("names the payment currency on a currency mismatch when the page knows it", () => {
    expect(pricingSaveError(denied("currency_mismatch"), english, { paymentCurrency: "EUR" })).toBe(
      english("pricing.editor.financeCurrencyMismatchExpected", { currency: "EUR" }),
    );
    expect(
      pricingSaveError(denied("currency_mismatch"), english, { paymentCurrency: "EUR" }),
    ).toContain("EUR");
    expect(pricingSaveError(denied("currency_mismatch"), english, { paymentCurrency: null })).toBe(
      english("pricing.editor.financeCurrencyMismatch"),
    );
  });
});

describe("a refused or failed price save names its reason (VAY-2471)", () => {
  it("says no access only for a refusal without a reason, and how to get access", () => {
    for (const data of [{}, { code: "forbidden" }, { code: "denied" }]) {
      const error = new ApiErrorResponse(403, data as never);
      expect(noPricingAccess(error)).toBe(true);
      expect(pricingSaveError(error, english)).toBe(english("pricing.editor.errorForbidden"));
    }
    expect(english("pricing.editor.errorForbidden")).toContain("Rooms & Rates access");
  });

  it("says prices changed for a stale save, and try again later for an outage or an unnamed reason", () => {
    const removed = new ApiErrorResponse(409, { code: "stale", reason: "room_unavailable" } as never);
    expect(pricingSaveError(removed, english)).toBe(english("pricing.editor.errorChanged"));
    for (const error of [new ApiErrorResponse(503, { code: "pricing_unavailable" } as never), denied("invalid")]) {
      expect(noPricingAccess(error)).toBe(false);
      expect(pricingSaveError(error, english)).toBe(english("pricing.editor.errorUnavailable"));
    }
  });
});
