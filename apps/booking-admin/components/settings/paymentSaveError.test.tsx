import { BankTransferValidationError } from "@vayada/product-onboarding/bankTransferDestination";
import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import { ApiErrorResponse } from "@/services/api/client";
import {
  buildFinancePaymentSettingsBody,
  FinancePaymentSettingsClientError,
} from "@/services/api/financePaymentSettingsClient";
import { paymentSaveError } from "./paymentSaveError";

function financeError(statusCode: number, code: string, detail: string) {
  return new FinancePaymentSettingsClientError({
    statusCode,
    code,
    category: "write_model",
    detail,
  });
}

function validationError(draft: Partial<Parameters<typeof buildFinancePaymentSettingsBody>[0]>) {
  try {
    buildFinancePaymentSettingsBody({
      payAtPropertyEnabled: false,
      onlineCardPayment: false,
      bankTransfer: false,
      paymentProvider: "stripe",
      defaultCurrency: "EUR",
      ...draft,
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected a validation error");
}

describe("paymentSaveError (VAY-2185)", () => {
  const cases: Array<[string, unknown, { message: string; retry: boolean }]> = [
    [
      "Pay at Hotel without Cash or Card",
      validationError({ payAtPropertyEnabled: true, payAtHotelMethods: [] }),
      { message: "settings.paymentsSave.payAtHotelMethods", retry: false },
    ],
    [
      "an invalid PayPal email",
      validationError({ paypalEnabled: true, paypalEmail: "nope" }),
      { message: "settings.paymentsSave.paypalEmail", retry: false },
    ],
    [
      "no payment method",
      validationError({}),
      { message: "settings.paymentsSave.noMethod", retry: false },
    ],
    [
      "incomplete bank details",
      new BankTransferValidationError("incomplete"),
      { message: "admin.enterTheCompleteBankDetailsOrLeaveAllFieldsEmpty", retry: false },
    ],
    [
      "Finance asking for Cash or Card",
      financeError(400, "invalid_command", "Pay at Hotel requires cash, card, or both."),
      { message: "settings.paymentsSave.payAtHotelMethods", retry: false },
    ],
    [
      "Finance missing the bank destination",
      financeError(400, "invalid_command", "Bank Transfer requires an enabled destination."),
      { message: "settings.paymentsSave.bankDetails", retry: false },
    ],
    [
      "a currency that changed meanwhile",
      financeError(
        409,
        "property_currency_conflict",
        "Payment currency changed to LKR. Reload before saving.",
      ),
      { message: "settings.paymentsSave.currencyChanged", retry: false },
    ],
    [
      "prices and booking settings in different currencies",
      financeError(
        409,
        "property_currency_conflict",
        "Prices use EUR but booking settings use LKR. Use one currency before saving payments.",
      ),
      { message: "settings.paymentsSave.currencyMismatch", retry: false },
    ],
    [
      "a stale bank destination version",
      new ApiErrorResponse(409, { detail: "Version conflict" }),
      { message: "settings.paymentsSave.reload", retry: false },
    ],
    [
      "no permission on the property link",
      new ApiErrorResponse(403, { detail: "Forbidden" }),
      { message: "settings.paymentsSave.noPermission", retry: false },
    ],
    [
      "no permission on Finance",
      financeError(403, "forbidden", "Forbidden"),
      { message: "settings.paymentsSave.noPermission", retry: false },
    ],
    [
      "an unreachable API",
      financeError(500, "network_unavailable", "Failed to fetch"),
      { message: "settings.billing.errorPaymentServerUnreachable", retry: true },
    ],
    [
      "a failed fetch before Finance",
      new TypeError("Failed to fetch"),
      { message: "settings.billing.errorPaymentServerUnreachable", retry: true },
    ],
    [
      "an unknown 400",
      financeError(400, "invalid_command", "Something else."),
      { message: "settings.paymentsSave.failed", retry: false },
    ],
    [
      "a server error",
      financeError(503, "write_model_unavailable", "Unavailable"),
      { message: "settings.paymentsSave.failed", retry: true },
    ],
  ];

  it.each(cases)("explains %s", (_name, error, expected) => {
    expect(paymentSaveError(error)).toEqual(expected);
    expect(en).toHaveProperty([expected.message]);
  });

  it("has a Try again label", () => {
    expect(en).toHaveProperty(["settings.paymentsSave.tryAgain"]);
  });
});
