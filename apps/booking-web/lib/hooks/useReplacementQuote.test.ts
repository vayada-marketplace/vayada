import { expect, it } from "vitest";
import { ApiError } from "@/services/api/client";
import { replacementQuoteErrorMessage } from "./useReplacementQuote";

it("explains a bank-transfer or PayPal quote refused for a close check-in (VAY-2145)", () => {
  expect(
    replacementQuoteErrorMessage(
      new ApiError("too soon", 422, { code: "MANUAL_PAYMENT_TOO_SOON" }),
    ),
  ).toBe("This payment method isn’t available this close to check-in. Choose another way to pay.");
  for (const error of [
    new ApiError("other", 422, { code: "OTHER" }),
    new ApiError("not found", 404, null),
    new Error("network"),
  ])
    expect(replacementQuoteErrorMessage(error)).toBe(
      "We couldn't price this selection. Check your room choices and try again.",
    );
});
