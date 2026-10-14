"use client";
import { useEffect, useState } from "react";
import { ApiError } from "@/services/api/client";
import { getStayPrices, type StayPrices, type StayQuery } from "@/services/api/stayPrices";

/** Stay prices for the room cards, reloaded 300 ms after the stay or guests change (as the old
 * booking page did) so quick +/- clicks send one request; the first load starts at once. A
 * newer stay cancels an older one. An API without the stay-prices read (404) means "no
 * prices": the cards stay choosable without a failure message. */
export function useStayPrices(slug: string, stay: StayQuery | null) {
  const identity = stay ? JSON.stringify([slug, stay]) : null;
  const [result, setResult] = useState<{
    identity: string;
    prices?: StayPrices;
    failed?: true;
    missing?: true;
  }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!identity) return;
    const [, query] = JSON.parse(identity) as [string, StayQuery];
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        getStayPrices(slug, query, controller.signal)
          .then((prices) => {
            if (!controller.signal.aborted) setResult({ identity, prices });
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            setResult(
              error instanceof ApiError && error.status === 404
                ? { identity, missing: true }
                : { identity, failed: true },
            );
          });
      },
      result ? 300 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // identity holds the whole stay, so an equal object is not a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, attempt]);
  const current = result?.identity === identity ? result : undefined;
  return {
    prices: current?.prices ?? null,
    loading: !!identity && !current,
    failed: !!current?.failed,
    /** No stay-prices read for this hotel: show the rooms without prices. */
    missing: !!current?.missing,
    retry: () => {
      setResult(undefined);
      setAttempt((value) => value + 1);
    },
  };
}
