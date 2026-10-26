import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { ApiError, GENERIC_ERROR_MESSAGE } from "@/services/api/client";

/** API codes guests read in their own language; the API's English message covers the rest. */
const TRANSLATED_CODES = {
  BOOKING_CANCEL_NON_REFUNDABLE: "cancelNonRefundable",
  BOOKING_CANCEL_DEADLINE_PASSED: "cancelDeadlinePassed",
  BOOKING_CANCEL_CHECK_IN_PASSED: "cancelCheckInPassed",
  BOOKING_CANCEL_NOT_ONLINE: "cancelNotOnline",
  BOOKING_CANCEL_FEE_CHANGED: "cancelFeeChanged",
  BOOKING_WITHDRAW_NOT_ONLINE: "withdrawNotOnline",
  BOOKING_NOT_CHANGEABLE: "bookingNotChangeable",
  busy_try_again: "busyTryAgain",
} as const;

export type GuestErrorKey = (typeof TRANSLATED_CODES)[keyof typeof TRANSLATED_CODES];

function errorCode(error: ApiError): unknown {
  return error.detail && typeof error.detail === "object"
    ? (error.detail as { code?: unknown }).code
    : undefined;
}

/** What a guest may read about a failed call (VAY-2308): a 4xx is the API's answer to this guest,
 * so it is shown, translated when its code is known. A 5xx or network failure gives null: the
 * caller shows its own generic text. */
export function guestError(error: unknown): { key: GuestErrorKey } | { message: string } | null {
  if (!(error instanceof ApiError) || error.status < 400 || error.status >= 500) return null;
  const code = errorCode(error);
  if (typeof code === "string" && Object.hasOwn(TRANSLATED_CODES, code))
    return { key: TRANSLATED_CODES[code as keyof typeof TRANSLATED_CODES] };
  return error.message && error.message !== GENERIC_ERROR_MESSAGE
    ? { message: error.message }
    : null;
}

/** The API refused for a reason that holds until the hotel steps in; trying again won't help. */
export function isLastingRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && errorCode(error) !== "busy_try_again";
}

/** `(error, fallback?) => text` in the page's language; the fallback defaults to "Something went wrong". */
export function useGuestErrorText() {
  const t = useTranslations("guestErrors");
  return useCallback(
    (error: unknown, fallback?: string): string => {
      const shown = guestError(error);
      if (!shown) return fallback ?? t("somethingWentWrong");
      return "key" in shown ? t(shown.key) : shown.message;
    },
    [t],
  );
}
