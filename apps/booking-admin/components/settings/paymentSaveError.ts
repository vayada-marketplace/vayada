import { BankTransferValidationError } from "@vayada/product-onboarding/bankTransferDestination";

import { ApiErrorResponse } from "@/services/api/client";
import {
  FinancePaymentSettingsClientError,
  PaymentSettingsValidationError,
  type PaymentSettingsField,
} from "@/services/api/financePaymentSettingsClient";

const FIELD_MESSAGES: Record<PaymentSettingsField, string> = {
  payAtHotelMethods: "settings.paymentsSave.payAtHotelMethods",
  paypalEmail: "settings.paymentsSave.paypalEmail",
  acceptedMethods: "settings.paymentsSave.noMethod",
};

// Finance's wording for the same checks (apps/api routes/finance.ts paymentSettingsCompletenessError).
const FINANCE_MESSAGES: Record<string, string> = {
  "Choose at least one payment method.": FIELD_MESSAGES.acceptedMethods,
  "Pay at Hotel requires cash, card, or both.": FIELD_MESSAGES.payAtHotelMethods,
  "PayPal requires a valid email address.": FIELD_MESSAGES.paypalEmail,
  "Bank Transfer requires an enabled destination.": "settings.paymentsSave.bankDetails",
};

export interface PaymentSaveError {
  /** Translation key. */
  message: string;
  /** Saving again unchanged may work, so the page offers Try again. */
  retry: boolean;
}

/** What Payments says when Save fails (VAY-2185): the field to fix, or what to do next. */
export function paymentSaveError(error: unknown): PaymentSaveError {
  if (error instanceof PaymentSettingsValidationError) {
    return { message: FIELD_MESSAGES[error.field], retry: false };
  }
  if (error instanceof BankTransferValidationError) {
    return { message: "admin.enterTheCompleteBankDetailsOrLeaveAllFieldsEmpty", retry: false };
  }
  if (
    error instanceof TypeError ||
    (error instanceof FinancePaymentSettingsClientError && error.code === "network_unavailable")
  ) {
    return { message: "settings.billing.errorPaymentServerUnreachable", retry: true };
  }
  if (error instanceof FinancePaymentSettingsClientError) {
    const fieldMessage = error.statusCode === 400 ? FINANCE_MESSAGES[error.detail] : undefined;
    if (fieldMessage) return { message: fieldMessage, retry: false };
    if (error.code === "property_currency_conflict") {
      return { message: "settings.paymentsSave.currencyChanged", retry: false };
    }
  }
  if (statusOf(error) === 403) {
    return { message: "settings.paymentsSave.noPermission", retry: false };
  }
  return { message: "settings.paymentsSave.failed", retry: true };
}

function statusOf(error: unknown): number | null {
  if (error instanceof ApiErrorResponse) return error.status;
  const statusCode =
    typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : null;
  return typeof statusCode === "number" ? statusCode : null;
}
