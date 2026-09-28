"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

import { AuthenticatedNavigation } from "@/components/layout";
import { useSidebar } from "@/components/layout/AuthenticatedNavigation";
import { AffiliatePayouts } from "@/components/marketplace/AffiliatePayouts";
import { resolveMarketplaceSetupGuard } from "@/lib/utils/sharedSetupGuard";
import {
  AFFILIATE_PERFORMANCE_PERIODS,
  AFFILIATE_PERFORMANCE_SOURCES,
  getAffiliatePerformance,
  type AffiliatePerformanceFilters,
  type AffiliatePerformancePage,
} from "@/services/api/affiliatePerformance";
import { authService } from "@/services/auth";

export default function EarningsPage() {
  const { isCollapsed } = useSidebar();
  const [period, setPeriod] = useState<AffiliatePerformanceFilters["period"]>("3m");
  const [source, setSource] = useState("");
  const [campaign, setCampaign] = useState("");
  const [filters, setFilters] = useState<AffiliatePerformanceFilters>({ period: "3m" });
  const [result, setResult] = useState<AffiliatePerformancePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMoreController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadMoreController.current?.abort();
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        await authService.ensureSession(controller.signal);
        const propertyId = await performancePropertyId();
        if (propertyId === null || controller.signal.aborted) return;
        const page = await getAffiliatePerformance(
          { ...filters, ...(propertyId && { propertyId }) },
          controller.signal,
        );
        if (!controller.signal.aborted) setResult(page);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [filters, retry]);

  function applyFilters(event: FormEvent) {
    event.preventDefault();
    setFilters({
      period,
      ...(source && { source: source as AffiliatePerformanceFilters["source"] }),
      ...(campaign.trim() && { campaign: campaign.trim() }),
    });
  }

  async function loadMore() {
    if (!result?.nextCursor) return;
    const cursor = result.nextCursor;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setLoadingMore(true);
    try {
      const page = await getAffiliatePerformance(
        {
          ...filters,
          ...(result.filters.propertyId && { propertyId: result.filters.propertyId }),
          cursor,
        },
        controller.signal,
      );
      if (!controller.signal.aborted)
        setResult((current) =>
          current?.nextCursor === cursor
            ? { ...page, partnerships: [...current.partnerships, ...page.partnerships] }
            : current,
        );
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (loadMoreController.current === controller) {
        loadMoreController.current = null;
        setLoadingMore(false);
      }
    }
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <AuthenticatedNavigation />
      <div className={`pt-12 transition-all ${isCollapsed ? "md:pl-14" : "md:pl-52"}`}>
        <div className="mx-auto max-w-6xl px-4 py-6 md:px-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Affiliate</p>
          <h1 className="mt-1 text-2xl font-bold text-gray-950 md:text-3xl">Results & earnings</h1>
          <p className="mt-1 text-sm text-gray-600">
            Performance across your authorized partnerships. Amounts stay separate by currency.
          </p>

          <form
            onSubmit={applyFilters}
            className="mt-5 grid gap-3 rounded-xl border bg-white p-4 sm:grid-cols-4"
          >
            <Filter label="Period">
              <select
                value={period}
                onChange={(event) => setPeriod(event.target.value as typeof period)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                {AFFILIATE_PERFORMANCE_PERIODS.map((value) => (
                  <option key={value} value={value}>
                    Last {value}
                  </option>
                ))}
              </select>
            </Filter>
            <Filter label="Source">
              <select
                value={source}
                onChange={(event) => setSource(event.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">All sources</option>
                {AFFILIATE_PERFORMANCE_SOURCES.map((value) => (
                  <option key={value} value={value}>
                    {label(value)}
                  </option>
                ))}
              </select>
            </Filter>
            <Filter label="Campaign">
              <input
                value={campaign}
                onChange={(event) => setCampaign(event.target.value)}
                maxLength={64}
                placeholder="All campaigns"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              />
            </Filter>
            <button
              type="submit"
              className="self-end rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700"
            >
              Apply filters
            </button>
          </form>

          {loading ? (
            <Loading />
          ) : error ? (
            <ErrorState onRetry={() => setRetry((value) => value + 1)} />
          ) : result ? (
            <Performance result={result} loadingMore={loadingMore} onLoadMore={loadMore} />
          ) : null}
          {authService.getUserType() !== "hotel" && <AffiliatePayouts />}
        </div>
      </div>
    </main>
  );
}

function Performance({
  result,
  loadingMore,
  onLoadMore,
}: {
  result: AffiliatePerformancePage;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  if (!result.partnerships.length)
    return (
      <section className="mt-5 rounded-xl border bg-white p-8 text-center">
        <h2 className="font-semibold text-gray-950">No affiliate partnerships yet</h2>
        <p className="mt-1 text-sm text-gray-600">
          Results will appear after an affiliate agreement becomes available.
        </p>
      </section>
    );
  const stale = result.partnerships.some((item) => item.freshness !== "current");
  const totals = result.partnerships.reduce(
    (value, item) => ({
      clicks: value.clicks + item.clicks,
      bookings: value.bookings + item.bookings,
      pending: value.pending + item.stays.pending + item.stays.needsReview,
      calculated: value.calculated + item.stays.calculated,
    }),
    { clicks: 0, bookings: 0, pending: 0, calculated: 0 },
  );
  const money = aggregateMoney(result.partnerships.flatMap((item) => item.commissions));
  return (
    <>
      {stale && (
        <div
          role="status"
          className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
        >
          <strong>Some evidence is delayed or missing.</strong> These results are not the same as
          confirmed zero bookings; earnings may change after verification.
        </div>
      )}
      <p className="mt-5 text-xs text-gray-500">
        Totals for partnerships shown{result.nextCursor ? "; load more to expand them." : "."}
      </p>
      <section
        aria-label="Affiliate totals for partnerships shown"
        className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-4"
      >
        <Metric label="Clicks" value={String(totals.clicks)} />
        <Metric
          label={stale ? "Recorded bookings" : "Bookings"}
          value={stale ? `≥${totals.bookings}` : String(totals.bookings)}
        />
        <Metric label="Awaiting verification" value={String(totals.pending)} />
        <Metric label="Calculated stays" value={String(totals.calculated)} />
      </section>
      <section className="mt-5 rounded-xl border bg-white p-4">
        <h2 className="font-semibold text-gray-950">Calculated earnings by currency</h2>
        <p className="mt-1 text-xs text-gray-500">
          Latest recorded calculations for the partnerships shown; not an eligible or payable
          balance.
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          {money.length ? (
            money.map((item) => (
              <div
                key={`${item.currency}:${item.scale}`}
                className="rounded-lg bg-gray-50 px-4 py-3"
              >
                <p className="text-lg font-bold text-gray-950">
                  {formatMinor(item.total, item.currency, item.scale)}
                </p>
                <p className="text-xs text-gray-500">
                  Calculated
                  {item.adjustment !== BigInt(0)
                    ? ` · ${formatMinor(item.adjustment, item.currency, item.scale)} latest adjustment`
                    : ""}
                </p>
              </div>
            ))
          ) : (
            <p className="text-sm text-gray-600">No recorded calculations for this period.</p>
          )}
        </div>
      </section>
      <section className="mt-5 space-y-3">
        <div>
          <h2 className="font-semibold text-gray-950">Partnership performance</h2>
          <p className="text-xs text-gray-500">
            {formatDate(result.period.from)}–{formatDate(result.period.to)} · refreshed{" "}
            {formatDate(result.readAt)}
          </p>
        </div>
        {result.partnerships.map((item) => (
          <article key={item.agreementId} className="rounded-xl border bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h3 className="font-semibold text-gray-950">{item.propertyName}</h3>
                <p className="text-xs text-gray-500">
                  {item.freshness === "current"
                    ? "Evidence current"
                    : item.freshness === "stale"
                      ? "Evidence is stale"
                      : "Evidence availability unknown"}
                </p>
              </div>
              <p className="text-sm font-medium text-gray-700">
                {item.clicks} clicks ·{" "}
                {item.freshness === "current"
                  ? `${item.bookings} bookings`
                  : "bookings not confirmed"}
              </p>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-gray-600">
              {item.sources.map((source) => (
                <span key={source.source} className="rounded-full bg-gray-100 px-2 py-1">
                  {label(source.source)} {source.clicks}
                </span>
              ))}
              {item.campaigns.map((campaign) => (
                <span
                  key={campaign.campaign ?? "unlabelled"}
                  className="rounded-full bg-gray-100 px-2 py-1"
                >
                  {campaign.campaign ?? "Unlabelled"} {campaign.clicks}
                </span>
              ))}
            </div>
          </article>
        ))}
      </section>
      {result.nextCursor && (
        <button
          type="button"
          disabled={loadingMore}
          onClick={onLoadMore}
          className="mt-4 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 disabled:opacity-60"
        >
          {loadingMore ? "Loading…" : "Load more partnerships"}
        </button>
      )}
      <StatusGuide />
    </>
  );
}

function StatusGuide() {
  const states = [
    ["Calculated estimate", "Verified stay evidence produced a commission calculation."],
    ["Awaiting verification", "Booking or stay evidence is delayed, incomplete, or needs review."],
    ["Latest adjustment", "A reversal or correction changed the latest calculated amount."],
  ];
  return (
    <section className="mt-5 rounded-xl border bg-white p-4">
      <h2 className="font-semibold text-gray-950">What each status means</h2>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        {states.map(([term, detail]) => (
          <div key={term}>
            <dt className="text-sm font-semibold text-gray-900">{term}</dt>
            <dd className="text-sm text-gray-600">{detail}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 rounded-lg bg-gray-50 p-3 text-sm text-gray-700">
        <strong>Payout status is not available in this results view.</strong> Eligibility,
        processing, paid confirmation, and payout dates require Finance payout records; this page
        does not infer them from commission calculations.
      </div>
    </section>
  );
}

function Filter({ label: text, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="text-xs font-semibold text-gray-600">
      {text}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
function Metric({ label: text, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-white p-4">
      <p className="text-xs text-gray-500">{text}</p>
      <p className="mt-1 text-2xl font-bold text-gray-950">{value}</p>
    </div>
  );
}
function Loading() {
  return (
    <div
      role="status"
      className="mt-5 rounded-xl border bg-white p-8 text-center text-sm text-gray-600"
    >
      Loading affiliate results…
    </div>
  );
}
function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="mt-5 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-950"
    >
      <p className="font-semibold">Could not load affiliate results</p>
      <p className="mt-1">Your existing partnerships and earnings are unchanged.</p>
      <button type="button" onClick={onRetry} className="mt-3 font-semibold underline">
        Retry
      </button>
    </div>
  );
}
function label(value: string) {
  return value === "x" ? "X" : value.charAt(0).toUpperCase() + value.slice(1);
}
function requestedPropertyId() {
  return new URLSearchParams(window.location.search).get("propertyId")?.trim() || undefined;
}
async function performancePropertyId(): Promise<string | null | undefined> {
  if (authService.getUserType() !== "hotel") return requestedPropertyId();
  const decision = await resolveMarketplaceSetupGuard(
    `${window.location.pathname}${window.location.search}`,
  );
  return decision.action === "enter_product" ? decision.propertyId : null;
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(value));
}
function formatMinor(value: bigint, currency: string, scale: number) {
  const sign = value < BigInt(0) ? "-" : "";
  const absolute = value < BigInt(0) ? -value : value;
  const digits = absolute.toString().padStart(scale + 1, "0");
  return `${currency} ${sign}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}
function aggregateMoney(
  commissions: AffiliatePerformancePage["partnerships"][number]["commissions"],
) {
  const values = new Map<
    string,
    { currency: string; scale: number; total: bigint; adjustment: bigint }
  >();
  for (const item of commissions) {
    const key = `${item.currency}:${item.currencyMinorUnit}`;
    const value = values.get(key) ?? {
      currency: item.currency,
      scale: item.currencyMinorUnit,
      total: BigInt(0),
      adjustment: BigInt(0),
    };
    value.total += BigInt(item.calculatedMinor);
    value.adjustment += BigInt(item.adjustmentMinor);
    values.set(key, value);
  }
  return Array.from(values.values());
}
