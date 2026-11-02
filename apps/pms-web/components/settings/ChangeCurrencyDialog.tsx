"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { PmsPricingCurrencyChangeBlocker } from "@vayada/domain-pms";
import Modal from "@/components/Modal";
import { useTranslation } from "@/lib/i18n";
import { ApiErrorResponse } from "@/services/api/client";
import {
  pricingCurrencyService,
  type PricingCurrencyState,
} from "@/services/settings/pricingCurrency";

/** VAY-2390 P5: the Owner's protected currency change. The numbers stay (100 EUR becomes 100 CHF),
 * so the booking page stops selling until the prices are published again. What blocks a change
 * shows on open, from a read-only preview; the change checks again in its own transaction, so the
 * reasons can still show after the attempt. */
export function ChangeCurrencyDialog({
  shownCurrency,
  onClose,
  onChanged,
}: {
  /** The currency the page shows; a hotel without its own pricing currency changes from it. */
  shownCurrency: string;
  onClose: () => void;
  onChanged: (currency: string) => void;
}) {
  const { t, locale } = useTranslation();
  const [state, setState] = useState<PricingCurrencyState | null>(null);
  // Set when loading failed: the status and code to quote to support, or "" when there is none.
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [next, setNext] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<PmsPricingCurrencyChangeBlocker[] | null>(null);
  // One key per chosen currency, so a retry after a lost response replays instead of repeating.
  const key = useRef("");

  useEffect(() => {
    let live = true;
    loadWithBlockers(shownCurrency).then(
      (loaded) => {
        if (!live) return;
        setState(loaded.state);
        if (loaded.blockers.length) setBlockers(loaded.blockers);
      },
      (cause: unknown) => live && setLoadFailed(errorCode(cause)),
    );
    return () => {
      live = false;
    };
  }, [shownCurrency]);
  const load = () => {
    setLoadFailed(null);
    loadWithBlockers(shownCurrency).then(
      (loaded) => {
        setState(loaded.state);
        if (loaded.blockers.length) setBlockers(loaded.blockers);
      },
      (cause: unknown) => setLoadFailed(errorCode(cause)),
    );
  };

  const name = (code: string) => {
    try {
      return new Intl.DisplayNames([locale], { type: "currency" }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  const from = state?.currency ?? "";
  const ready = !!state && !!next && typed.trim().toUpperCase() === next;

  async function change() {
    if (!state || !ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await pricingCurrencyService.change(state, next, key.current);
      if (outcome.kind === "changed") return onChanged(outcome.currency);
      if (outcome.kind === "blocked") return setBlockers(outcome.blockers);
      // The page's currency itself is stale when the hotel had no pricing currency of its own.
      if (state.revision === 0) return window.location.reload();
      setError("settings.currencyChange.stale");
      key.current = globalThis.crypto.randomUUID();
      load();
    } catch {
      setError("settings.currencyChange.failed");
    } finally {
      setBusy(false);
    }
  }

  if (blockers) {
    const setupOnly = blockers.every(({ code }) => code === "hotel_setup_incomplete");
    return (
      <Modal
        ariaLabel={t("settings.currencyChange.blockedTitle")}
        onClose={onClose}
        footer={
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white"
            >
              {t("settings.currencyChange.ok")}
            </button>
          </div>
        }
      >
        <h2 className="text-lg font-semibold text-gray-900">
          {t("settings.currencyChange.blockedTitle")}
        </h2>
        <p className="mt-2 text-sm text-gray-600">
          {setupOnly
            ? t("settings.currencyChange.setupIntro")
            : t("settings.currencyChange.blockedIntro", { from })}
        </p>
        <ul className="mt-4 divide-y divide-gray-100 rounded-lg border border-gray-200">
          {blockerItems(blockers, state?.propertyId).map((item) => (
            <li key={item.title} className="flex gap-3 p-4">
              <span
                aria-hidden="true"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-50 text-xs font-semibold text-red-700"
              >
                {item.count ?? "!"}
              </span>
              <div className="text-sm">
                <p className="font-medium text-gray-900">
                  {t(item.title, { count: item.count ?? 0, from })}
                </p>
                <p className="mt-0.5 text-gray-600">{t(item.body, { from })}</p>
                {item.link && (
                  <Link
                    href={item.link.href}
                    className="mt-1 inline-block text-primary-600 hover:underline"
                  >
                    {t(item.link.label)}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Modal>
    );
  }

  return (
    <Modal
      ariaLabel={t("settings.currencyChange.title")}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className="flex justify-end gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={!ready || busy}
            onClick={() => void change()}
            className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy
              ? t("settings.currencyChange.changing")
              : t("settings.currencyChange.submit", { code: next || "…" })}
          </button>
        </div>
      }
    >
      <h2 className="text-lg font-semibold text-gray-900">{t("settings.currencyChange.title")}</h2>
      <p className="mt-2 text-sm text-gray-600">{t("settings.currencyChange.intro")}</p>
      {loadFailed !== null ? (
        <div role="alert" className="mt-4 text-sm text-red-700">
          {t("settings.currencyChange.loadError")}{" "}
          <button type="button" onClick={load} className="font-medium underline">
            {t("common.retry")}
          </button>
          {loadFailed && (
            <p className="mt-1 text-xs text-gray-500">
              {t("settings.currencyChange.loadErrorCode", { code: loadFailed })}
            </p>
          )}
        </div>
      ) : !state ? (
        <p role="status" className="mt-4 text-sm text-gray-500">
          {t("settings.currencyChange.loading")}
        </p>
      ) : (
        <>
          <label className="mt-4 block text-sm font-medium text-gray-700">
            {t("settings.currencyChange.newCurrency")}
            <select
              value={next}
              disabled={busy}
              onChange={(event) => {
                setNext(event.target.value);
                setTyped("");
                setError(null);
                key.current = globalThis.crypto.randomUUID();
              }}
              className="mt-1.5 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">{t("settings.currencyChange.choose")}</option>
              {state.supported
                .filter((code) => code !== state.currency)
                .map((code) => (
                  <option key={code} value={code}>
                    {code} · {name(code)}
                  </option>
                ))}
            </select>
          </label>
          {next && (
            <>
              <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
                <p className="font-semibold">{t("settings.currencyChange.noteTitle")}</p>
                <p className="mt-1">{t("settings.currencyChange.noteBody", { from, to: next })}</p>
              </div>
              <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-gray-700">
                <li>{t("settings.currencyChange.pointPublish")}</li>
                <li>{t("settings.currencyChange.pointAddons")}</li>
                <li>{t("settings.currencyChange.pointHistory", { from })}</li>
              </ul>
              <label className="mt-4 block text-sm font-medium text-gray-700">
                {t("settings.currencyChange.confirmLabel", { code: next })}
                <input
                  value={typed}
                  disabled={busy}
                  autoComplete="off"
                  onChange={(event) => setTyped(event.target.value)}
                  className="mt-1.5 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {t(error)}
        </p>
      )}
    </Modal>
  );
}

/** A preview that fails leaves the reasons to the change, which checks them anyway. */
async function loadWithBlockers(shownCurrency: string) {
  const state = await pricingCurrencyService.load(shownCurrency);
  const blockers = await pricingCurrencyService
    .blockers(state)
    .catch((): PmsPricingCurrencyChangeBlocker[] => []);
  return { state, blockers };
}

/** What support needs from a failed load: the API's status and error code (VAY-2453). */
function errorCode(cause: unknown): string {
  if (!(cause instanceof ApiErrorResponse)) return "";
  return [cause.status, cause.data.code].filter(Boolean).join(" ");
}

type BlockerItem = {
  title: string;
  body: string;
  count?: number;
  link?: { href: string; label: string };
};

/** One line per reason the API gave; older price records share one line. */
function blockerItems(
  blockers: readonly PmsPricingCurrencyChangeBlocker[],
  propertyId: string | undefined,
): BlockerItem[] {
  const items: BlockerItem[] = [];
  const codes = new Set(blockers.map(({ code }) => code));
  // VAY-2453: setup chooses the first currency, and with it switches on Financials.
  if (codes.has("hotel_setup_incomplete"))
    items.push({
      title: "settings.currencyChange.blockedSetupTitle",
      body: "settings.currencyChange.blockedSetupBody",
      link: {
        href: `/setup?${new URLSearchParams({
          entryProduct: "pms",
          returnTo: "/settings/property",
          ...(propertyId ? { propertyId } : {}),
          step: "payments",
        }).toString()}`,
        label: "settings.currencyChange.blockedSetupLink",
      },
    });
  const bookings = blockers.find(({ code }) => code === "booking_reference");
  if (bookings)
    items.push({
      title: "settings.currencyChange.blockedBookingsTitle",
      body: "settings.currencyChange.blockedBookingsBody",
      count: bookings.affectedCount ?? 1,
      link: { href: "/bookings", label: "settings.currencyChange.blockedBookingsLink" },
    });
  if (codes.has("channel_connection"))
    items.push({
      title: "settings.currencyChange.blockedChannelsTitle",
      body: "settings.currencyChange.blockedChannelsBody",
    });
  if (codes.has("finance_record") || codes.has("payment_configuration"))
    items.push({
      title: "settings.currencyChange.blockedFinanceTitle",
      body: "settings.currencyChange.blockedFinanceBody",
    });
  if (
    ["flexible_rate_plan", "legacy_rate_plan", "rate_rule", "legacy_room_type_price"].some((code) =>
      codes.has(code as PmsPricingCurrencyChangeBlocker["code"]),
    ) ||
    codes.has("published_reference") ||
    codes.has("other_pricing_configuration")
  )
    items.push({
      title: "settings.currencyChange.blockedLegacyTitle",
      body: "settings.currencyChange.blockedLegacyBody",
    });
  if (codes.has("dependency_check_unavailable") || !items.length)
    items.push({
      title: "settings.currencyChange.blockedUnknownTitle",
      body: "settings.currencyChange.blockedUnknownBody",
    });
  return items;
}
