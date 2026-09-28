"use client";

import { useEffect, useRef, useState } from "react";

import {
  downloadAffiliatePayoutStatement,
  getAffiliatePayout,
  getAffiliatePayouts,
  startAffiliateStripeSetup,
  type AffiliatePayoutDetail,
  type AffiliatePayoutPage,
} from "@/services/api/affiliatePayouts";

export function AffiliatePayouts() {
  const [page, setPage] = useState<AffiliatePayoutPage | null>(null);
  const [detail, setDetail] = useState<AffiliatePayoutDetail | null>(null);
  const [country, setCountry] = useState("");
  const stripeCommand = useRef<{ country: string; id: string } | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [actionError, setActionError] = useState(false);

  async function load(signal?: AbortSignal) {
    setState("loading");
    try {
      setPage(await getAffiliatePayouts(signal));
      setState("ready");
    } catch {
      if (!signal?.aborted) setState("error");
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
      detailController.current?.abort();
    };
  }, []);

  async function open(payoutId: string, currency: string) {
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    setActionError(false);
    try {
      const response = await getAffiliatePayout(payoutId, currency, controller.signal);
      if (!controller.signal.aborted) setDetail(response.payout);
    } catch {
      if (!controller.signal.aborted) setActionError(true);
    } finally {
      if (detailController.current === controller) detailController.current = null;
    }
  }

  async function connectStripe() {
    const normalizedCountry = country.trim().toUpperCase();
    setActionError(false);
    try {
      if (stripeCommand.current?.country !== normalizedCountry)
        stripeCommand.current = { country: normalizedCountry, id: crypto.randomUUID() };
      const result = await startAffiliateStripeSetup(normalizedCountry, stripeCommand.current.id);
      window.location.assign(result.onboardingUrl);
    } catch {
      setActionError(true);
    }
  }

  async function download(payoutId: string, currency: string) {
    setActionError(false);
    try {
      const blob = await downloadAffiliatePayoutStatement(payoutId, currency);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `payout-${payoutId}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setActionError(true);
    }
  }

  const payoutsReady = Boolean(
    page?.payoutSettings.payoutsEnabled && page.payoutSettings.providerAccount.payoutsEnabled,
  );

  return (
    <section className="mt-5 rounded-xl border bg-white p-4" aria-labelledby="payouts-heading">
      <h2 id="payouts-heading" className="font-semibold text-gray-950">
        Payouts & statements
      </h2>
      <p className="mt-1 text-xs text-gray-500">
        Only Finance-confirmed payouts appear as paid. Eligible and calculated earnings remain
        separate above.
      </p>
      {state === "loading" && (
        <p role="status" className="mt-4 text-sm text-gray-600">
          Loading payouts…
        </p>
      )}
      {state === "error" && (
        <div role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-900">
          Payout details are temporarily unavailable. Existing earnings and payout evidence are
          unchanged.
          <button
            type="button"
            onClick={() => void load()}
            className="ml-2 font-semibold underline"
          >
            Retry
          </button>
        </div>
      )}
      {actionError && (
        <div role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-900">
          That payout action could not be completed. Your payout records are unchanged; try the
          action again.
        </div>
      )}
      {state === "ready" && page && (
        <>
          <div className="mt-4 rounded-lg bg-gray-50 p-3 text-sm text-gray-700">
            <p>
              <strong>Destination:</strong>{" "}
              {page.payoutSettings.providerAccount.maskedReference ?? "Not connected"}
            </p>
            <p>
              <strong>Readiness:</strong>{" "}
              {payoutsReady ? "Ready" : "Setup required"}
            </p>
            {!payoutsReady && page.payoutSettings.payoutProvider === "stripe" && (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className="text-xs font-semibold text-gray-600">
                  Country
                  <input
                    aria-label="Payout country"
                    value={country}
                    maxLength={2}
                    placeholder="DE"
                    onChange={(event) => setCountry(event.target.value)}
                    className="ml-2 w-16 rounded border px-2 py-1 uppercase"
                  />
                </label>
                <button
                  type="button"
                  disabled={!/^[A-Za-z]{2}$/.test(country)}
                  onClick={() => void connectStripe()}
                  className="rounded bg-primary-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                >
                  Connect Stripe
                </button>
              </div>
            )}
          </div>
          {page.payouts.length ? (
            <ul className="mt-4 divide-y">
              {page.payouts.map((payout) => (
                <li key={payout.payoutId} className="py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-semibold text-gray-900">
                        {payout.currency} {payout.netAmount} · {status(payout.payoutStatus)}
                      </p>
                      <p className="text-xs text-gray-500">
                        Gross {payout.amount} · fees {payout.feeAmount}
                        {payout.failureCode ? ` · ${payout.failureCode}` : ""}
                      </p>
                    </div>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => void open(payout.payoutId, payout.currency)}
                        className="font-semibold text-primary-700 underline"
                      >
                        View detail
                      </button>
                      <button
                        type="button"
                        onClick={() => void download(payout.payoutId, payout.currency)}
                        className="font-semibold text-primary-700 underline"
                      >
                        Download statement
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-gray-600">No Finance payout records yet.</p>
          )}
        </>
      )}
      {detail && (
        <div className="mt-4 rounded-lg border p-3" aria-label="Payout detail">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-gray-900">Included commissions</h3>
              <p className="text-xs text-gray-500">
                {detail.maskedDestination ??
                  detail.maskedProviderReference ??
                  "Destination unavailable"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                detailController.current?.abort();
                setDetail(null);
              }}
              aria-label="Close payout detail"
              className="text-sm underline"
            >
              Close
            </button>
          </div>
          <ul className="mt-2 divide-y text-sm">
            {detail.includedEarnings.map((item) => (
              <li key={item.earningEntryId} className="py-2">
                {item.currency} {minor(item.appliedMinor, item.currencyMinorUnit)} applied · booking{" "}
                {item.bookingReference}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function status(value: AffiliatePayoutPage["payouts"][number]["payoutStatus"]) {
  return value === "paid"
    ? "Paid"
    : value === "failed"
      ? "Failed — action may be required"
      : value.charAt(0).toUpperCase() + value.slice(1);
}
function minor(value: string, scale: number) {
  const negative = value.startsWith("-");
  const digits = (negative ? value.slice(1) : value).padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}
