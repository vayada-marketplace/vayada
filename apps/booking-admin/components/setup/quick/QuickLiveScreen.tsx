"use client";

import {
  ArrowRightIcon,
  CheckCircleIcon,
  CreditCardIcon,
  GlobeAltIcon,
  PaintBrushIcon,
  PhotoIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useState, type ComponentType, type SVGProps } from "react";

import { QuickBookingPagePreview, type QuickPreviewRoom } from "./QuickBookingPagePreview";
import { QuickSetupPreviewCard } from "./QuickSetupPreviewCard";
import { QuickSetupShell } from "./QuickSetupShell";

export type QuickLiveScreenProps = {
  hotel: { name: string; place: string };
  currency: { code: string; symbol: string };
  room: QuickPreviewRoom | null;
  /**
   * The published booking page, e.g. "https://hotel-alpenrose.booking.vayada.com/en"; null while guests
   * can't open published pages yet (the booking site is still switching over, VAY-2134).
   */
  url: string | null;
  /** The address in the preview's browser bar when there is no published link yet. */
  previewHost: string;
  /** Copies the link; resolves once it is on the clipboard. */
  copy: (url: string) => Promise<void>;
  onRoomsAndRates: () => void;
  onDesignStudio: () => void;
  onPaymentSettings: () => void;
  onDashboard: () => void;
};

/** "hotel-alpenrose.booking.vayada.com" from the published URL. */
export function quickLiveHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

function NextStep({
  icon: Icon,
  title,
  note,
  link,
  onClick,
}: {
  icon: Icon;
  title: string;
  note: string;
  link: string;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-gray-200 bg-white p-5 lg:px-4">
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-50 text-primary-700">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <p className="mt-4 text-[15px] font-semibold text-gray-950 lg:text-sm">{title}</p>
      <p className="mt-1 text-sm leading-5 text-gray-600 lg:text-[13px]">{note}</p>
      <button
        type="button"
        onClick={onClick}
        className="mt-3 flex w-fit items-center gap-1 rounded text-sm font-semibold lg:text-[13px] text-primary-600 outline-none hover:text-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 lg:mt-auto lg:pt-3"
      >
        {link}
        <ArrowRightIcon className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * VAY-2247 "You're live" (Paper rev 4 a08, logo only): the hotel is open for bookings. The link to share,
 * three next steps that open the pages that already exist, and the live booking page next to it.
 */
export function QuickLiveScreen({
  hotel,
  currency,
  room,
  url,
  previewHost,
  copy,
  onRoomsAndRates,
  onDesignStudio,
  onPaymentSettings,
  onDashboard,
}: QuickLiveScreenProps) {
  const host = url ? quickLiveHost(url) : previewHost;
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <QuickSetupShell step={null}>
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 px-4 pb-6 pt-4 lg:flex-row lg:items-stretch lg:gap-8 lg:px-12 lg:pb-16 lg:pt-10">
        <section
          aria-labelledby="quick-setup-heading"
          className="flex min-w-0 flex-col gap-6 rounded-2xl border border-gray-200 bg-white px-[23px] py-6 lg:w-[658px] lg:shrink-0 lg:gap-7 lg:p-10"
        >
          <header>
            <p className="flex w-fit items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-1 text-[13px] font-semibold text-green-700">
              <CheckCircleIcon className="h-4 w-4" aria-hidden="true" />
              Live now
            </p>
            <h1
              id="quick-setup-heading"
              tabIndex={-1}
              className="mt-4 text-[26px] font-bold leading-tight tracking-tight text-gray-950 outline-none lg:text-[32px]"
            >
              {`${hotel.name} is open for bookings`}
            </h1>
            <p className="mt-2 text-[15px] leading-6 text-gray-600 lg:text-base">
              Share your link, put it on your website, or send it to your last guests.
            </p>
          </header>
          {url ? (
            <div className="flex flex-col gap-3 rounded-xl border border-primary-200 bg-white p-3 lg:flex-row lg:items-center lg:gap-3 lg:px-4">
              <p className="flex min-w-0 items-start gap-3 lg:items-center">
                <GlobeAltIcon
                  className="mt-0.5 h-5 w-5 shrink-0 text-primary-700 lg:mt-0"
                  aria-hidden="true"
                />
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="break-words text-[15px] font-semibold text-gray-950 hover:underline lg:text-sm"
                >
                  {host}
                </a>
              </p>
              <button
                type="button"
                onClick={() => {
                  if (url)
                    void copy(url).then(
                      () => setCopied("copied"),
                      () => setCopied("failed"),
                    );
                }}
                className="h-9 shrink-0 rounded-full bg-primary-600 px-4 text-sm font-semibold text-white outline-none hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
              >
                {copied === "copied" ? "Copied" : "Copy link"}
              </button>
              <span role="status" className="sr-only">
                {copied === "copied"
                  ? "Link copied"
                  : copied === "failed"
                    ? "Couldn't copy the link. Select it and copy it instead."
                    : ""}
              </span>
            </div>
          ) : (
            <p className="rounded-xl border border-primary-100 bg-primary-50 px-4 py-3 text-sm leading-5 text-primary-800">
              Your booking page is published. Guests can open it once we finish switching the
              booking site over, and your link appears here.
            </p>
          )}
          <div>
            <h2 className="text-base font-semibold text-gray-950">Make it even better</h2>
            <div className="mt-4 grid gap-4 lg:grid-cols-3 lg:gap-3">
              <NextStep
                icon={PhotoIcon}
                title="Add photos"
                note="Hotels with photos get booked more often."
                link="Rooms & Rates"
                onClick={onRoomsAndRates}
              />
              <NextStep
                icon={PaintBrushIcon}
                title="Logo and colours"
                note="Make the page look like your hotel."
                link="Design Studio"
                onClick={onDesignStudio}
              />
              <NextStep
                icon={CreditCardIcon}
                title="Online cards"
                note="Let guests pay when they book."
                link="Payment settings"
                onClick={onPaymentSettings}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={onDashboard}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-primary-600 px-6 text-base font-semibold text-white outline-none hover:bg-primary-700 focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 lg:w-fit"
          >
            Go to my dashboard
            <ArrowRightIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </section>
        <div className="flex min-w-0 flex-col lg:flex-1 lg:justify-center">
          <QuickSetupPreviewCard caption="Your booking page is live">
            <QuickBookingPagePreview
              url={host}
              hotelName={hotel.name}
              place={hotel.place}
              currencySymbol={currency.symbol}
              rooms={room ? [room] : []}
              live
            />
          </QuickSetupPreviewCard>
        </div>
      </div>
    </QuickSetupShell>
  );
}
