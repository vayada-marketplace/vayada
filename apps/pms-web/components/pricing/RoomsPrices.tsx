"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { pricingCurrencyScale } from "@vayada/domain-pms/replacement-pricing";
import { useTranslation } from "@/lib/i18n";
import { ApiErrorResponse } from "@/services/api/client";
import { resolveSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";
import {
  createReplacementPricingClient,
  type PricingSnapshot,
} from "@/services/api/replacementPricingClient";

import { decimalAmount } from "./pricingAmounts";
import { financeNotReady, pricingSave, pricingSaveError } from "./savePricing";
import * as ui from "./pricingStyles";

type Client = ReturnType<typeof createReplacementPricingClient>;
type Publication = Awaited<ReturnType<Client["read"]>>;
export type PropertyPrices = {
  prices: { client: Client; publication: Publication } | null;
  error: unknown;
  reload: () => Promise<void>;
};

/** The selected property's published prices for the Rooms list. A failed read leaves the list usable. */
export function usePropertyPrices(): PropertyPrices {
  const [prices, setPrices] = useState<PropertyPrices["prices"]>(null),
    [error, setError] = useState<unknown>(null);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    setError(null);
    try {
      const client = createReplacementPricingClient(
        await resolveSelectedPmsPropertyId("loading prices"),
      );
      const publication = await client.read();
      if (alive.current) setPrices({ client, publication });
    } catch (e) {
      if (alive.current) setError(e);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);
  return { prices, error, reload };
}

/** The lowest base nightly amount among the room's independently priced offers (minor units), if any. */
export function lowestBaseMinor(room: PricingSnapshot["rooms"][number]): string | null {
  const minors = room.offers.flatMap((offer) => {
    const base = offer.price.kind === "independent" ? offer.price.calendar.base : null;
    return !base
      ? []
      : base.mode === "flat"
        ? [base.amountMinor]
        : base.mode === "occupancy"
          ? base.amountsMinor
          : base.mode === "per_person"
            ? [base.unitMinor]
            : [base.baseMinor];
  });
  return minors.length
    ? minors.reduce((lowest, minor) => (BigInt(minor) < BigInt(lowest) ? minor : lowest))
    : null;
}

/** A price for the Rooms list: the currency code and the locale's digit grouping, with no ".00" on a whole
 * amount, e.g. "IDR 875,000" or "EUR 120.50" (VAY-2338). */
export function listPrice(minor: string, currency: string, locale: string): string {
  const scale = pricingCurrencyScale(currency)!;
  const digits = BigInt(minor) % BigInt(10 ** scale) === BigInt(0) ? 0 : scale;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: "code",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(decimalAmount(minor, scale)));
}

function publishedRoom(publication: Publication, roomTypeId: string) {
  return publication?.rooms.find(
    (value) => value.roomTypeId.toLowerCase() === roomTypeId.toLowerCase(),
  );
}

/** A room's published prices in its Rooms list row: "from IDR 875,000" over "2 rates · per night", or that guests
 * can't book it yet. */
export function RoomPriceSummary({
  roomTypeId,
  publication,
}: {
  roomTypeId: string;
  publication: Publication;
}) {
  const { t, locale } = useTranslation();
  const room = publishedRoom(publication, roomTypeId);
  if (!room)
    return (
      <>
        <p className="text-[15px] font-medium text-gray-500">{t("pricing.list.noPrices")}</p>
        <p className="text-[13px] text-amber-700">{t("pricing.list.cantBook")}</p>
      </>
    );
  const lowest = lowestBaseMinor(room);
  const rates = t(
    room.offers.length === 1 ? "pricing.list.rates.one" : "pricing.list.rates.other",
    {
      count: room.offers.length,
    },
  );
  return (
    <>
      <p className="text-[15px] font-semibold text-gray-900 tabular-nums">
        {lowest
          ? t("pricing.list.from", { price: listPrice(lowest, publication!.currency, locale) })
          : rates}
      </p>
      {lowest && (
        <p className="text-[13px] text-gray-500">{`${rates} · ${t("pricing.list.perNight")}`}</p>
      )}
    </>
  );
}

/** "Edit prices", or "Set prices" for a room without published prices: a link to the room's Prices tab. It is a
 * document navigation, so the tab's leave warning also covers the browser's back button. Until the prices are read
 * (publication undefined) it says "Edit prices". */
export function RoomPricesLink({
  roomTypeId,
  publication,
}: {
  roomTypeId: string;
  publication: Publication | undefined;
}) {
  const { t } = useTranslation();
  return (
    <a
      href={`/rooms/${encodeURIComponent(roomTypeId)}?tab=prices`}
      onClick={(event) => event.stopPropagation()}
      className="whitespace-nowrap px-1.5 text-sm font-semibold text-primary-600 hover:text-primary-700"
    >
      {t(
        publication === undefined || publishedRoom(publication, roomTypeId)
          ? "pricing.list.editPrices"
          : "pricing.list.setPrices",
      )}
    </a>
  );
}

/** Property-wide prices above the Rooms list: the currency, and for a stale publication "Save prices again",
 * which republishes every room unchanged (the press is the mandatory-charges declaration). `staleOnly` (a room
 * page, e.g. after a room-details save made the prices stale) shows only that republish and its outcome, or that
 * the prices could not be checked. `onSaved` runs after a republish. */
export function RoomsPricesStrip({
  prices,
  error,
  reload,
  staleOnly = false,
  onSaved,
}: PropertyPrices & { staleOnly?: boolean; onSaved?: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<unknown>(null),
    [retry, setRetry] = useState(false),
    [saved, setSaved] = useState(false);
  const step = useRef<(() => Promise<unknown>) | null>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function run() {
    if (!step.current || busy) return;
    setBusy(true);
    setFailure(null);
    setSaved(false);
    try {
      await step.current();
      step.current = null;
      if (alive.current) {
        setRetry(false);
        setSaved(true);
      }
      onSaved?.();
      await reload();
    } catch (e) {
      if (!alive.current) return;
      setFailure(e);
      // Payment settings can be fixed without a reload; a refused save shows the latest state; anything else
      // may have been accepted, so only "Retry last action" continues it with the same keys.
      if (financeNotReady(e)) {
        step.current = null;
        setRetry(false);
      } else if (e instanceof ApiErrorResponse && [400, 403, 409].includes(e.status)) {
        step.current = null;
        setRetry(false);
        await reload();
      } else setRetry(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function saveAgain() {
    const publication = prices?.publication;
    if (!prices || !publication || busy) return;
    const revision = publication.revision + 1;
    step.current = pricingSave(prices.client, {
      snapshot: {
        currency: publication.currency,
        ownerReferences: { finance: publication.ownerReferences.finance },
        rooms: publication.rooms.map((room) => ({ ...room, revision })),
      },
      baseRevision: publication.revision,
      terms: [],
    });
    void run();
  }
  const message = (e: unknown) =>
    e instanceof ApiErrorResponse && e.status === 409
      ? t("pricing.list.changed")
      : pricingSaveError(e, t);
  if (error)
    return (
      <div
        role="alert"
        className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[12px] text-red-800"
      >
        {t("pricing.list.loadFailed")}{" "}
        <button type="button" onClick={() => void reload()} className="font-semibold underline">
          {t("common.retry")}
        </button>
      </div>
    );
  const publication = prices?.publication;
  // On the Rooms list the subtitle carries the currency, so current prices show nothing here (VAY-2338).
  const quiet = !publication?.stale && !saved && failure === null;
  if (!prices || (quiet && (staleOnly || publication))) return null;
  const saveButton = (
    <button
      type="button"
      disabled={busy}
      onClick={retry ? () => void run() : saveAgain}
      className={
        staleOnly
          ? `mt-3 ${ui.primaryButton}`
          : "inline-flex shrink-0 items-center justify-center rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
      }
    >
      {t(
        busy ? "pricing.editor.saving" : retry ? "pricing.editor.retry" : "pricing.list.saveAgain",
      )}
    </button>
  );
  return (
    <section
      aria-label={t("pricing.list.label")}
      // On a room page only the warning shows, as a banner like Room Details' messages.
      className={staleOnly ? "mb-4 text-[11px]" : "mb-4 text-[12px]"}
    >
      {!staleOnly && !publication && <p className={ui.infoBanner}>{t("pricing.list.none")}</p>}
      {publication?.stale &&
        (staleOnly ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-800">
            <p className="font-semibold">{t("pricing.list.staleTitle")}</p>
            <p className="mt-1">{t("pricing.list.staleBody")}</p>
            {saveButton}
            <p className="mt-2 text-[10px] text-amber-700">{t("pricing.editor.saveDeclaration")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-800 sm:flex-row sm:items-center sm:gap-4">
            <ExclamationTriangleIcon
              aria-hidden="true"
              className="hidden h-5 w-5 shrink-0 text-amber-700 sm:block"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t("pricing.list.staleTitle")}</p>
              <p className="mt-0.5 text-[13px]">{t("pricing.list.staleBody")}</p>
              <p className="mt-1 text-xs text-amber-700">{t("pricing.editor.saveDeclaration")}</p>
            </div>
            {saveButton}
          </div>
        ))}
      {failure !== null && (
        <p role="alert" className={staleOnly ? `mt-2 ${ui.errorBanner}` : "mt-2 text-red-700"}>
          {message(failure)}
          {retry && ` ${t("pricing.editor.retryHint")}`}
        </p>
      )}
      {saved && failure === null && !publication?.stale && (
        <p role="status" className={staleOnly ? `mt-2 ${ui.successBanner}` : "mt-2 text-green-700"}>
          {t("pricing.list.savedAgain")}
        </p>
      )}
    </section>
  );
}
