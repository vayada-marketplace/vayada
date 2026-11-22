"use client";

import { useEffect, useId, useRef } from "react";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import {
  parsePropertyLocationChangeConfirmation,
  type PropertyLocationChanges,
} from "@vayada/domain-hotels";
import { trapFocus } from "@/components/Modal";
import { useTranslation } from "@/lib/i18n";
import { formatTimezoneLabel } from "@/lib/timezoneLabel";

/** VAY-2582: what a live hotel's refused save asks the person to confirm, or null for any other error. */
export function locationChangeToConfirm(error: unknown): PropertyLocationChanges | null {
  const data =
    typeof error === "object" && error !== null ? (error as { data?: unknown }).data : undefined;
  return parsePropertyLocationChangeConfirmation(data);
}

function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/**
 * VAY-2582: guests can book a live hotel, so moving its time zone or country waits for this question
 * (designed in Paper, "VAY-2582 Live hotel: confirm time zone / country change"). The server asks it: a
 * save without the confirmation answers `location_change_needs_confirmation` with the changes. "Keep …"
 * only closes the question; what the person typed stays, so they can fix it. "Change …" saves again with
 * the confirmation. Rendered inside a native modal <dialog> too (the address popup), so it covers the
 * screen itself instead of portalling under the top layer.
 */
export function LocationChangeConfirmDialog({
  changes,
  currentTimeZone,
  confirming,
  onKeep,
  onConfirm,
}: {
  changes: PropertyLocationChanges;
  /** The hotel's time zone, named when only the country changes (it stays). */
  currentTimeZone: string;
  /** The confirmed save is running. */
  confirming: boolean;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  const { t, locale } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const { timezone, countryCode } = changes;
  const both = Boolean(timezone && countryCode);

  // Focus starts on "Keep …", the choice that changes nothing, and goes back where it was afterwards.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const previous = document.activeElement as HTMLElement | null;
    keepButton.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const keep = () => {
    if (!confirming) onKeep();
  };
  const title = both
    ? t("settings.property.locationConfirm.titleBoth")
    : timezone
      ? t("settings.property.locationConfirm.titleTimeZone")
      : t("settings.property.locationConfirm.titleCountry");
  const keepLabel = both
    ? t("settings.property.locationConfirm.keepCurrent")
    : t("settings.property.locationConfirm.keep", {
        value: timezone
          ? formatTimezoneLabel(timezone.from)
          : countryName(countryCode?.from ?? "", locale),
      });
  const changeLabel = both
    ? t("settings.property.locationConfirm.changeBoth")
    : timezone
      ? t("settings.property.locationConfirm.changeTimeZone")
      : t("settings.property.locationConfirm.changeCountry");
  const rows = [
    countryCode && {
      label: t("settings.property.locationConfirm.country"),
      from: countryName(countryCode.from, locale),
      to: countryName(countryCode.to, locale),
    },
    timezone && {
      label: t("settings.property.locationConfirm.timeZone"),
      from: formatTimezoneLabel(timezone.from),
      to: formatTimezoneLabel(timezone.to),
    },
  ].filter((row): row is { label: string; from: string; to: string } => Boolean(row));
  const timeZonePoints = [
    { text: t("settings.property.locationConfirm.recalculates"), stops: false },
    { text: t("settings.property.locationConfirm.pausesBookingPage"), stops: true },
    { text: t("settings.property.locationConfirm.channelManager"), stops: false },
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
        onKeyDown={(event) => {
          // Inside the address popup's <dialog>, Escape must close this question, not the popup.
          if (event.key === "Escape") event.preventDefault();
          trapFocus(event, panel.current, keep);
        }}
        className="relative flex max-h-[90dvh] w-full max-w-lg min-w-0 flex-col overflow-hidden rounded-xl bg-white text-left text-gray-900 shadow-xl"
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
                {t("settings.property.locationConfirm.live")}
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
                    <span className="sr-only">{t("settings.property.locationConfirm.to")}</span>
                    <span className="font-semibold text-gray-900">{row.to}</span>
                  </dd>
                </div>
              ))}
            </dl>

            {timezone ? (
              <div className="space-y-2">
                <p className="text-[14px] font-semibold leading-5">
                  {both
                    ? t("settings.property.locationConfirm.changingTimeZone")
                    : t("settings.property.locationConfirm.whatThisDoes")}
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
                {timezone
                  ? t("settings.property.locationConfirm.countryCheck")
                  : t("settings.property.locationConfirm.countryKeepsTimeZone", {
                      timeZone: formatTimezoneLabel(currentTimeZone),
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
            className="h-10 rounded-lg border border-gray-300 bg-white px-4 text-[14px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {keepLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming}
            className="h-10 rounded-lg bg-primary-600 px-4 text-[14px] font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {confirming ? t("common.saving") : changeLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
