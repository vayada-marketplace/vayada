"use client";
import { useEffect, useState } from "react";
import type {
  PublicBookingQuote,
  PublicBookingQuoteRequest,
} from "@vayada/domain-booking/replacement-pricing";
import { requestReplacementQuote } from "@/services/api/replacementQuote";

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
              error: "This price has expired. Get an updated price.",
            }),
          Math.max(0, Date.parse(quote.expiresAt) - Date.now()),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setResult({
            identity,
            attempt,
            error: "We couldn't price this selection. Check your room choices and try again.",
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
    loading: !!request && submitted === identity && attempt > 0 && !current,
    submit: () => {
      setSubmitted(identity);
      setAttempt((value) => value + 1);
    },
  };
}
