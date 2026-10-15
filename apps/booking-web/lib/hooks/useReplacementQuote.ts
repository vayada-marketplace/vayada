"use client";
import { useEffect, useState } from "react";
import type {
  PublicBookingQuote,
  PublicBookingQuoteRequest,
} from "@vayada/domain-booking/replacement-pricing";
import { ApiError } from "@/services/api/client";
import { serverNow } from "@/lib/serverClock";
import { requestReplacementQuote } from "@/services/api/replacementQuote";

/** The server's code for a refused quote, when it sent one. */
export function replacementQuoteErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || !error.detail || typeof error.detail !== "object")
    return undefined;
  const code = (error.detail as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** The guest's message when a quote is refused. */
export function replacementQuoteErrorMessage(error: unknown): string {
  // VAY-2145: bank transfer and PayPal need their payment deadline to end before check-in.
  if (
    error instanceof ApiError &&
    error.status === 422 &&
    !!error.detail &&
    typeof error.detail === "object" &&
    (error.detail as { code?: unknown }).code === "MANUAL_PAYMENT_TOO_SOON"
  )
    return "This payment method isn’t available this close to check-in. Choose another way to pay.";
  return "We couldn't price this selection. Check your room choices and try again.";
}

/** Display only the submitted selection, and retire it on edit, tenant change or expiry. */
export function useReplacementQuote(slug: string, request: PublicBookingQuoteRequest | null) {
  const identity = JSON.stringify([slug, request]);
  const [attempt, setAttempt] = useState(0);
  const [submitted, setSubmitted] = useState("");
  const [result, setResult] = useState<{
    identity: string;
    attempt: number;
    quote?: PublicBookingQuote;
    error?: string;
    /** The HTTP status of a refused quote, when the server answered. */
    errorStatus?: number;
    errorCode?: string;
  }>();
  useEffect(() => {
    if (submitted !== identity) {
      setResult(undefined);
      setSubmitted("");
      return;
    }
    if (!request || !slug || !attempt) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const [, body] = JSON.parse(identity) as [string, PublicBookingQuoteRequest];
    void requestReplacementQuote(slug, body, controller.signal)
      .then((quote) => {
        if (controller.signal.aborted) return;
        setResult({ identity, attempt, quote });
        timer = setTimeout(
          () =>
            setResult({
              identity,
              attempt,
              quote,
              error: "This price has expired. Get an updated price.",
            }),
          Math.max(0, Date.parse(quote.expiresAt) - serverNow()),
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            identity,
            attempt,
            error: replacementQuoteErrorMessage(error),
            errorStatus: error instanceof ApiError ? error.status : undefined,
            errorCode: replacementQuoteErrorCode(error),
          });
      });
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // identity contains the complete request, so an equivalent object is not a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, submitted, attempt, slug]);
  const current = result?.identity === identity && result.attempt === attempt ? result : undefined;
  return {
    quote: current?.quote,
    error: current?.error,
    errorStatus: current?.errorStatus,
    errorCode: current?.errorCode,
    loading: !!request && submitted === identity && attempt > 0 && !current,
    submit: () => {
      setSubmitted(identity);
      setAttempt((value) => value + 1);
    },
  };
}
