"use client";

import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  GlobeAltIcon,
  InformationCircleIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";

import { QuickBookingPagePreview, type QuickPreviewRoom } from "./QuickBookingPagePreview";
import { QuickSetupShell } from "./QuickSetupShell";

/** What the first run filled in for the hotel (VAY-2247 W1 defaults). */
export const QUICK_GO_LIVE_DEFAULTS =
  "Open all year · free cancellation until 3 days · check-in 15:00, out 11:00 · standard terms · Classic style";

export type QuickGoLiveStatus =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "publishing" }>
  | Readonly<{ kind: "failed"; message: string }>;

export type QuickGoLiveStepProps = {
  hotel: { name: string; place: string; url: string };
  currency: { code: string; symbol: string };
  rooms: readonly QuickPreviewRoom[];
  status: QuickGoLiveStatus;
  onPublish: () => void;
  onRetry: () => void;
  /** "Not yet — go to my dashboard". */
  onDashboard: () => void;
  /** Opens the settings with the defaults the first run chose. */
  onReview: () => void;
  onSaveAndExit: () => void;
};

const BUTTON =
  "inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed";
const PRIMARY = `${BUTTON} bg-primary-600 text-white hover:bg-primary-700 disabled:bg-primary-200 disabled:hover:bg-primary-200`;
const SECONDARY = `${BUTTON} border border-gray-300 bg-white text-gray-950 hover:bg-gray-50 disabled:opacity-40`;

function PublishButton({
  status,
  onPublish,
  className = "",
}: Pick<QuickGoLiveStepProps, "status" | "onPublish"> & { className?: string }) {
  const publishing = status.kind === "publishing";
  return (
    <button
      type="button"
      onClick={onPublish}
      disabled={status.kind !== "ready"}
      aria-busy={publishing || undefined}
      className={`${PRIMARY} ${className}`}
    >
      {publishing ? (
        <ArrowPathIcon className="h-5 w-5 animate-spin" aria-hidden="true" />
      ) : (
        <GlobeAltIcon className="h-5 w-5" aria-hidden="true" />
      )}
      {publishing ? "Publishing…" : "Publish booking page"}
    </button>
  );
}

function StatusBanner({ status, onRetry }: Pick<QuickGoLiveStepProps, "status" | "onRetry">) {
  if (status.kind === "publishing") {
    return (
      <div
        role="status"
        className="flex gap-3 rounded-xl border border-primary-100 bg-primary-50 px-4 py-3.5 text-primary-800"
      >
        <InformationCircleIcon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div className="text-sm leading-5">
          <p className="font-semibold">Publishing…</p>
          <p className="mt-0.5">Publishing your booking page. This takes about 10 seconds.</p>
        </div>
      </div>
    );
  }
  if (status.kind === "failed") {
    return (
      <div
        role="alert"
        className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3.5 text-red-700 sm:flex-row sm:items-start"
      >
        <div className="flex min-w-0 flex-1 gap-3">
          <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div className="text-sm leading-5">
            <p className="font-semibold text-red-800">We couldn&apos;t publish yet</p>
            <p className="mt-0.5">{status.message}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="h-9 shrink-0 self-start rounded-full border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-950 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 sm:ml-0"
        >
          Try again
        </button>
      </div>
    );
  }
  return null;
}

/**
 * VAY-2247 step 5, "Does this look right?" (Paper rev 4 a07): one centred card with the booking page,
 * what the first run filled in, and the publish button. Publishing and its failure show above the preview.
 */
export function QuickGoLiveStep({
  hotel,
  currency,
  rooms,
  status,
  onPublish,
  onRetry,
  onDashboard,
  onReview,
  onSaveAndExit,
}: QuickGoLiveStepProps) {
  // Leaving while it publishes is fine: the request is saved and the server finishes it.
  return (
    <QuickSetupShell step={5} onSaveAndExit={onSaveAndExit}>
      <div className="mx-auto w-full max-w-[792px] px-4 pb-6 pt-4 lg:px-4 lg:pb-16 lg:pt-10">
        <section
          aria-labelledby="quick-setup-heading"
          className="flex flex-col gap-6 rounded-2xl border border-gray-200 bg-white px-[23px] py-6 lg:items-center lg:gap-6 lg:px-10 lg:py-10"
        >
          <header className="lg:text-center">
            <h1
              id="quick-setup-heading"
              tabIndex={-1}
              className="text-[26px] font-bold leading-tight tracking-tight text-gray-950 outline-none lg:text-[34px]"
            >
              Does this look right?
            </h1>
            <p className="mt-1.5 text-[15px] leading-6 text-gray-600 lg:mt-3 lg:text-[17px]">
              This is your booking page. Publish it now — you can change everything later.
            </p>
          </header>
          {status.kind === "publishing" || status.kind === "failed" ? (
            <div className="w-full">
              <StatusBanner status={status} onRetry={onRetry} />
            </div>
          ) : null}
          <div className="w-full lg:max-w-[600px]">
            <QuickBookingPagePreview
              url={hotel.url}
              hotelName={hotel.name}
              place={hotel.place}
              currencySymbol={currency.symbol}
              rooms={rooms}
            />
          </div>
          <div className="flex w-full items-start gap-3 rounded-xl border border-gray-200 bg-white px-4 py-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
              <SparklesIcon className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-gray-950">We filled in the rest for you</p>
              <p className="mt-1 text-sm leading-5 text-gray-600">{QUICK_GO_LIVE_DEFAULTS}</p>
            </div>
            <button
              type="button"
              onClick={onReview}
              className="shrink-0 rounded text-sm font-semibold text-primary-600 outline-none hover:text-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600"
            >
              Review
            </button>
          </div>
          <div className="hidden items-center justify-center gap-3 lg:flex">
            <button type="button" onClick={onDashboard} className={SECONDARY}>
              Not yet — go to my dashboard
            </button>
            <PublishButton status={status} onPublish={onPublish} />
          </div>
        </section>
      </div>
      <div className="flex flex-col gap-2.5 border-t border-gray-200 bg-white px-4 pb-7 pt-3 lg:hidden">
        <PublishButton status={status} onPublish={onPublish} className="w-full" />
        <button
          type="button"
          onClick={onDashboard}
          className={`${BUTTON} w-full text-gray-700 hover:bg-gray-50 disabled:opacity-40`}
        >
          Not yet — go to my dashboard
        </button>
      </div>
    </QuickSetupShell>
  );
}
