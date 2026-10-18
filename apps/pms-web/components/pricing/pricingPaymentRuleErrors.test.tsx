import { describe, expect, it } from "vitest";
import { ApiErrorResponse } from "@/services/api/client";
import { errorText } from "./pricingAmounts";
import { pricingSaveError } from "./savePricing";

const t = (key: string) => key;

describe("Paid when booking refusals (VAY-2205)", () => {
  it("names the rule instead of saying the prices changed", () => {
    for (const [code, key] of [
      ["payment_methods_required", "pricing.error.paymentMethodRequired"],
      ["deposit_card_only", "pricing.error.depositCardOnly"],
      ["deposit_rest_at_property", "pricing.error.depositRestAtProperty"],
      ["deposit_below_full_stay", "pricing.error.depositBelowFullStay"],
    ]) {
      const refused = new ApiErrorResponse(400, { code } as never);
      expect(pricingSaveError(refused, t as never)).toBe(key);
      expect(errorText(refused, t as never, "pricing.editor.errorSaveFailed")).toBe(key);
    }
    expect(
      pricingSaveError(new ApiErrorResponse(409, { code: "stale" } as never), t as never),
    ).toBe("pricing.editor.errorChanged");
  });
});
