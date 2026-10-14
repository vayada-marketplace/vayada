"use client";
import { useEffect, useState } from "react";
import type {
  PublicBookingQuote,
  PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import { getQuoteGuestDisclosure } from "@/services/api/quoteGuestDisclosure";

/** The hotel's guest rules for one quote (VAY-2195): the details step reads them, and they decide
 * which guest fields show (VAY-2163). They stay with their quote after it expires, so the form
 * doesn't change under the guest. */
export function useQuoteGuestDisclosure(slug: string, quote: PublicBookingQuote | undefined) {
  const identity = quote
    ? JSON.stringify([slug, quote.quoteId, quote.issuedAt, quote.expiresAt])
    : "";
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{
    identity: string;
    disclosure?: PublicQuoteGuestDisclosure;
    failed?: boolean;
  }>();
  useEffect(() => {
    if (!quote) return;
    const controller = new AbortController();
    void getQuoteGuestDisclosure(slug, quote, controller.signal)
      .then((disclosure) => {
        if (!controller.signal.aborted) setState({ identity, disclosure });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ identity, failed: true });
      });
    return () => controller.abort();
    // The quote ID identifies immutable evidence; dates prevent reusing malformed replacements.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, retry]);
  const current = state?.identity === identity ? state : undefined;
  return {
    disclosure: current?.disclosure ?? null,
    failed: !!current?.failed,
    retry: () => setRetry((value) => value + 1),
  };
}
