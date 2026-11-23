"use client";

import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import {
  parsePropertyLocationChangeConfirmation,
  type PropertyLocationChanges,
} from "@vayada/domain-hotels";

/**
 * The question's English text, as Flamur approved it for the PMS (Paper, "VAY-2582 Live hotel: confirm time
 * zone / country change"). The PMS keeps it under `settings.property.locationConfirm.*`; Booking Admin
 * supplies these keys in its own catalogs (VAY-2586).
 */
export const locationChangeConfirmEnglish = {
  "locationConfirm.titleTimeZone": "Change your hotel's time zone?",
  "locationConfirm.titleCountry": "Change your hotel's country?",
  "locationConfirm.titleBoth": "Change your hotel's country and time zone?",
  "locationConfirm.live": "Guests can book your hotel now.",
  "locationConfirm.country": "Country",
  "locationConfirm.timeZone": "Time zone",
  "locationConfirm.to": "to",
  "locationConfirm.whatThisDoes": "What this does:",
  "locationConfirm.changingTimeZone": "Changing the time zone:",
  "locationConfirm.recalculates": "recalculates your calendar in the new time zone",
  "locationConfirm.pausesBookingPage":
    "pauses your booking page until you save your calendar again in Settings › Calendar",
  "locationConfirm.channelManager":
    "needs your channel manager to use the same time zone, or its sync stops",
  "locationConfirm.countryKeepsTimeZone":
    "The time zone stays {timeZone}, so your calendar and booking page keep working. Check that your currency and channel manager still match the new country.",
  "locationConfirm.countryCheck":
    "Check that your currency and channel manager still match the new country.",
  "locationConfirm.keep": "Keep {value}",
  "locationConfirm.keepCurrent": "Keep current",
  "locationConfirm.changeTimeZone": "Change time zone",
  "locationConfirm.changeCountry": "Change country",
  "locationConfirm.changeBoth": "Change country and time zone",
  "locationConfirm.saving": "Saving…",
} as const;

export type LocationChangeConfirmKey = keyof typeof locationChangeConfirmEnglish;
export type LocationChangeConfirmTranslate = (
  key: LocationChangeConfirmKey,
  params?: Record<string, string>,
) => string;

const english: LocationChangeConfirmTranslate = (key, params = {}) =>
  Object.entries(params).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(value),
    locationChangeConfirmEnglish[key] as string,
  );

/** VAY-2582: what a live hotel's refused save asks the person to confirm, or null for any other error. */
export function locationChangeToConfirm(error: unknown): PropertyLocationChanges | null {
  const data =
    typeof error === "object" && error !== null ? (error as { data?: unknown }).data : undefined;
  return parsePropertyLocationChangeConfirmation(data);
}

/** Time zones read as in the PMS Settings list: "America/Sao_Paulo" as "America/Sao Paulo". */
const timeZoneLabel = (timezone: string) => timezone.replaceAll("_", " ");

function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** Escape answers "Keep …"; Tab stays inside the question. */
function trapFocus(
  event: KeyboardEvent<HTMLDivElement>,
  panel: HTMLDivElement | null,
  close: () => void,
) {
  if (event.key === "Escape") return close();
  if (event.key !== "Tab") return;
  const nodes = Array.from(
    panel?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [],
  );
  if (!nodes.length) return event.preventDefault();
  const first = nodes[0]!;
  const last = nodes.at(-1)!;
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * VAY-2582: guests can book a live hotel, so moving its time zone or country waits for this question
 * (designed in Paper, "VAY-2582 Live hotel: confirm time zone / country change"). The server asks it: a
 * save without the confirmation answers `location_change_needs_confirmation` with the changes. "Keep …"
 * only closes the question; what the person typed stays, so they can fix it. "Change …" saves again with
 * the confirmation. Rendered inside a native modal <dialog> too (the PMS address popup), so it covers the
 * screen itself instead of portalling under the top layer. Shared by the PMS and Booking Admin › Settings ›
 * Location (VAY-2586).
 */
export function LocationChangeConfirmDialog({
  changes,
  currentTimeZone,
  confirming,
  onKeep,
  onConfirm,
  returnFocusId,
  translate = english,
  locale = "en",
}: {
  changes: PropertyLocationChanges;
  /** The hotel's saved time zone, named when only the country changes (it stays); "" when it has none. */
  currentTimeZone: string;
  /** The confirmed save is running. */
  confirming: boolean;
  onKeep: () => void;
  onConfirm: () => void;
  /** The field to focus afterwards; else whatever had the focus, if it still can take it. */
  returnFocusId?: string;
  /** The app's copy for these keys; English without it. */
  translate?: LocationChangeConfirmTranslate;
  /** For the country names. */
  locale?: string;
}) {
  const t = translate;
  const titleId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const { timezone, countryCode } = changes;
  const both = Boolean(timezone && countryCode);

  // Focus starts on "Keep …", the choice that changes nothing, and goes back afterwards: to the field to
  // fix, or where it was (a Save button disabled during the save may have dropped it to the body).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const previous = document.activeElement as HTMLElement | null;
    keepButton.current?.focus();
    return () => {
      const target =
        (returnFocusId ? document.getElementById(returnFocusId) : null) ??
        (previous && previous !== document.body && previous.isConnected ? previous : null);
      target?.focus?.();
    };
  }, [returnFocusId]);

  const keep = () => {
    if (!confirming) onKeep();
  };
  const title = both
    ? t("locationConfirm.titleBoth")
    : timezone
      ? t("locationConfirm.titleTimeZone")
      : t("locationConfirm.titleCountry");
  const keepLabel = both
    ? t("locationConfirm.keepCurrent")
    : t("locationConfirm.keep", {
        value: timezone
          ? timeZoneLabel(timezone.from)
          : countryName(countryCode?.from ?? "", locale),
      });
  const changeLabel = both
    ? t("locationConfirm.changeBoth")
    : timezone
      ? t("locationConfirm.changeTimeZone")
      : t("locationConfirm.changeCountry");
  const rows = [
    countryCode && {
      label: t("locationConfirm.country"),
      from: countryName(countryCode.from, locale),
      to: countryName(countryCode.to, locale),
    },
    timezone && {
      label: t("locationConfirm.timeZone"),
      from: timeZoneLabel(timezone.from),
      to: timeZoneLabel(timezone.to),
    },
  ].filter((row): row is { label: string; from: string; to: string } => Boolean(row));
  const timeZonePoints = [
    { text: t("locationConfirm.recalculates"), stops: false },
    { text: t("locationConfirm.pausesBookingPage"), stops: true },
    { text: t("locationConfirm.channelManager"), stops: false },
  ];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={keep} aria-hidden="true" />
      <div
        ref={panel}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        // A click on the text keeps the focus here, so Escape and Tab still reach the question.
        tabIndex={-1}
        onKeyDown={(event) => {
          // Inside the address popup's <dialog>, Escape must close this question, not the popup.
          if (event.key === "Escape") event.preventDefault();
          trapFocus(event, panel.current, keep);
        }}
        className="relative flex max-h-[90dvh] w-full max-w-lg min-w-0 flex-col overflow-hidden rounded-xl bg-white text-left text-gray-900 shadow-xl outline-none [overflow-wrap:anywhere]"
      >
        <div className="min-h-0 overflow-y-auto">
          <div className="flex items-start gap-3.5 px-6 pt-6">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100">
              <ExclamationTriangleIcon className="h-5 w-5 text-amber-700" aria-hidden="true" />
            </div>
            <div className="min-w-0 pt-0.5">
              <h2
                id={titleId}
                className="text-[18px] font-semibold leading-[26px] tracking-[-0.01em]"
              >
                {title}
              </h2>
              <p id={descriptionId} className="mt-1 text-[14px] leading-5 text-gray-600">
                {t("locationConfirm.live")}
              </p>
            </div>
          </div>

          <div className="space-y-4 px-6 pb-6 pt-4 sm:pl-[78px]">
            <dl className="divide-y divide-gray-200 rounded-[10px] border border-gray-200 bg-gray-50">
              {rows.map((row) => (
                <div
                  key={row.label}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5"
                >
                  <dt className="w-[76px] shrink-0 text-[13px] leading-[18px] text-gray-500">
                    {row.label}
                  </dt>
                  <dd className="flex min-w-0 flex-wrap items-center gap-x-3 text-[14px] leading-5">
                    <span className="text-gray-500">{row.from}</span>
                    <span className="text-gray-400" aria-hidden="true">
                      →
                    </span>
                    <span className="sr-only">{t("locationConfirm.to")}</span>
                    <span className="font-semibold text-gray-900">{row.to}</span>
                  </dd>
                </div>
              ))}
            </dl>

            {timezone ? (
              <div className="space-y-2">
                <p className="text-[14px] font-semibold leading-5">
                  {both ? t("locationConfirm.changingTimeZone") : t("locationConfirm.whatThisDoes")}
                </p>
                <ul className="space-y-2">
                  {timeZonePoints.map((point) => (
                    <li
                      key={point.text}
                      className="flex items-start gap-2.5 text-[14px] leading-5 text-gray-700"
                    >
                      <span
                        aria-hidden="true"
                        className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${
                          point.stops ? "bg-amber-600" : "bg-gray-400"
                        }`}
                      />
                      <span>{point.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {countryCode ? (
              <p className="text-[14px] leading-5 text-gray-600">
                {/* With the time zone moving too, or none saved yet, nothing "stays". */}
                {timezone || !currentTimeZone.trim()
                  ? t("locationConfirm.countryCheck")
                  : t("locationConfirm.countryKeepsTimeZone", {
                      timeZone: timeZoneLabel(currentTimeZone.trim()),
                    })}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-col-reverse gap-2.5 border-t border-gray-200 bg-gray-50 px-6 py-4 sm:flex-row sm:justify-end">
          <button
            ref={keepButton}
            type="button"
            onClick={keep}
            disabled={confirming}
            className="min-h-10 rounded-lg border border-gray-300 bg-white px-4 py-2 text-[14px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {keepLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming}
            className="min-h-10 rounded-lg bg-primary-600 px-4 py-2 text-[14px] font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {confirming ? t("locationConfirm.saving") : changeLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
