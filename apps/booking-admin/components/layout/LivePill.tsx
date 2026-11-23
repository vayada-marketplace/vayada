"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowTopRightOnSquareIcon, ChevronDownIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";
import { bookingPageStatus } from "@/lib/utils/bookingPageStatus";
import { buildBookingPreviewUrl } from "@/lib/utils/bookingPreviewUrl";
import { bookingPublicationApi } from "@/services/api/bookingPublicationClient";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import { BOOKING_PAGE_ONLINE_EVENT } from "@/components/dashboard/bookingPageEvents";

type PageState = { live: boolean; url: string | null };

/**
 * Whether the hotel's booking page is live, with its address, Open page and Copy link
 * (VAY-2594). Replaces the old Preview button: an offline page still opens at the address it
 * will have, as Preview did.
 */
export default function LivePill({
  hotelId,
  propertyId,
  slug,
}: {
  hotelId?: string;
  propertyId?: string;
  slug?: string;
}) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const [page, setPage] = useState<PageState | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // One read at a time: a request while one runs (focus and visibilitychange both fire when the
  // hotel comes back) reads once more after it, so the last answer is always the newest.
  const reading = useRef(false);
  const again = useRef(false);

  const read = useCallback(async () => {
    if (!hotelId) return;
    if (reading.current) {
      again.current = true;
      return;
    }
    reading.current = true;
    try {
      do {
        again.current = false;
        try {
          const id = propertyId ?? (await getBookingHotelPropertyLink({ hotelId })).propertyId;
          const status = bookingPageStatus(await bookingPublicationApi.load(id));
          setPage(
            status.kind === "online"
              ? { live: true, url: status.url }
              : {
                  live: false,
                  url: buildBookingPreviewUrl({
                    slug: slug ?? "",
                    template: process.env.NEXT_PUBLIC_BOOKING_URL_TEMPLATE,
                    location: window.location,
                  }),
                },
          );
        } catch {
          // A read that fails keeps what the pill showed; without a first answer it stays hidden,
          // e.g. for staff who can't see the booking page's status.
        }
      } while (again.current);
    } finally {
      reading.current = false;
    }
  }, [hotelId, propertyId, slug]);

  // Read again on every page change: a save in Settings can take the page offline.
  useEffect(() => {
    void read();
  }, [read, pathname]);

  useEffect(() => {
    // Read again when the dashboard publishes the page, and when the hotel comes back to the tab.
    const onReturn = () => {
      if (document.visibilityState === "visible") void read();
    };
    const onOnline = () => void read();
    window.addEventListener(BOOKING_PAGE_ONLINE_EVENT, onOnline);
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener(BOOKING_PAGE_ONLINE_EVENT, onOnline);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [read]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!page) return null;
  const domain = page.url?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? null;
  const copy = () => {
    if (!page.url) return;
    void navigator.clipboard
      ?.writeText(page.url)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };

  return (
    <div className="relative" ref={box}>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          if (!open) void read();
          setCopied(false);
          setOpen(!open);
        }}
        className={`flex h-8 items-center gap-2 rounded-full border px-3 text-[13px] text-gray-900 transition-colors max-sm:gap-1.5 max-sm:px-2.5 ${
          page.live
            ? "border-[#CDEBD8] bg-[#F1FAF4] hover:bg-[#E6F6EC]"
            : "border-[#F4C7C3] bg-[#FEF3F2] hover:bg-[#FDE7E5]"
        }`}
      >
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${page.live ? "bg-[#16A34A]" : "bg-[#D92D20]"}`}
        />
        {/* On phones only the dot shows, so the search box keeps its room. */}
        <span className="font-semibold max-sm:sr-only">
          {page.live ? t("layout.header.livePill.live") : t("layout.header.livePill.offline")}
        </span>
        {domain && (
          <span className="hidden max-w-[220px] truncate text-gray-500 xl:inline">{domain}</span>
        )}
        <ChevronDownIcon
          aria-hidden="true"
          className={`h-3 w-3 shrink-0 text-gray-500 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t("layout.header.livePill.title")}
          // Under the pill, right-aligned; on phones across the screen with a 16px gutter.
          className="absolute right-0 top-[calc(100%+0.5rem)] z-50 flex w-[300px] flex-col gap-3 rounded-xl border border-gray-200 bg-white p-3.5 shadow-[0_12px_32px_rgba(17,24,39,0.12)] max-sm:fixed max-sm:inset-x-4 max-sm:top-14 max-sm:w-auto"
        >
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-gray-500">{t("layout.header.livePill.title")}</span>
            {domain && (
              <span className="break-all text-sm font-semibold text-gray-900">{domain}</span>
            )}
            <span className="text-xs text-gray-500">
              {page.live
                ? t("layout.header.livePill.liveDetail")
                : t("layout.header.livePill.offlineDetail")}
            </span>
          </div>
          {page.url ? (
            <div className="flex gap-2">
              <a
                href={page.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary-500 text-[13px] font-semibold text-white transition-colors hover:bg-primary-600"
              >
                {t("layout.header.livePill.openPage")}
                <ArrowTopRightOnSquareIcon aria-hidden="true" className="h-3.5 w-3.5" />
              </a>
              <button
                type="button"
                onClick={copy}
                className="h-9 flex-1 rounded-lg border border-gray-300 bg-white text-[13px] font-medium text-gray-900 transition-colors hover:bg-gray-50"
              >
                <span aria-live="polite">
                  {copied
                    ? t("layout.header.livePill.copied")
                    : t("layout.header.livePill.copyLink")}
                </span>
              </button>
            </div>
          ) : (
            <p className="text-xs text-gray-600">
              {t("admin.finishBookingSetupBeforePreviewingYourBookingPage")}
            </p>
          )}
          <Link
            href="/design-studio"
            onClick={() => setOpen(false)}
            className="text-[13px] font-medium text-primary-600 hover:text-primary-700"
          >
            {t("layout.header.livePill.editInDesignStudio")} →
          </Link>
        </div>
      )}
    </div>
  );
}
