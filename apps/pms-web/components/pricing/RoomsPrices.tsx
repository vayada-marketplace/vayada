"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

/** A room's published prices on its Rooms list card, with a link to its Prices tab. The link is a document
 * navigation, so the tab's leave warning also covers the browser's back button. */
export function RoomPriceSummary({
  roomTypeId,
  publication,
}: {
  roomTypeId: string;
  publication: Publication;
}) {
  const { t } = useTranslation();
  const room = publication?.rooms.find(
    (value) => value.roomTypeId.toLowerCase() === roomTypeId.toLowerCase(),
  );
  const lowest = room && lowestBaseMinor(room);
  const href = `/rooms/${encodeURIComponent(roomTypeId)}?tab=prices`;
  return (
    <>
      <span className={room ? "font-medium text-gray-800 tabular-nums" : "text-gray-500"}>
        {!room
          ? t("pricing.list.noPrices")
          : [
              t(room.offers.length === 1 ? "pricing.list.rates.one" : "pricing.list.rates.other", {
                count: room.offers.length,
              }),
              ...(lowest
                ? [
                    t("pricing.list.from", {
                      amount: decimalAmount(lowest, pricingCurrencyScale(publication!.currency)!),
                      currency: publication!.currency,
                    }),
                  ]
                : []),
            ].join(" · ")}
      </span>
      <a
        href={href}
        onClick={(event) => event.stopPropagation()}
        className="font-medium text-primary-600 hover:text-primary-700"
      >
        {t(room ? "pricing.list.editPrices" : "pricing.list.setPrices")}
      </a>
    </>
  );
}

/** Property-wide prices above the Rooms list: the currency, and for a stale publication "Save prices again",
 * which republishes every room unchanged (the press is the mandatory-charges declaration). */
export function RoomsPricesStrip({ prices, error, reload }: PropertyPrices) {
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
  if (!prices) return null;
  const publication = prices.publication;
  return (
    <section
      aria-label={t("pricing.list.label")}
      className="mb-4 rounded-xl border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-700"
    >
      <p>
        {publication
          ? t("pricing.list.currency", { currency: publication.currency })
          : t("pricing.list.none")}
      </p>
      {publication?.stale && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
          <p className="font-semibold">{t("pricing.list.staleTitle")}</p>
          <p className="mt-1">{t("pricing.list.staleBody")}</p>
          <button
            type="button"
            disabled={busy}
            onClick={retry ? () => void run() : saveAgain}
            className="mt-3 rounded-lg bg-emerald-700 px-4 py-2 text-[12px] font-medium text-white disabled:opacity-50"
          >
            {t(
              busy
                ? "pricing.editor.saving"
                : retry
                  ? "pricing.editor.retry"
                  : "pricing.list.saveAgain",
            )}
          </button>
          <p className="mt-2">{t("pricing.editor.saveDeclaration")}</p>
        </div>
      )}
      {failure !== null && (
        <p role="alert" className="mt-2 text-red-700">
          {message(failure)}
          {retry && ` ${t("pricing.editor.retryHint")}`}
        </p>
      )}
      {saved && failure === null && !publication?.stale && (
        <p role="status" className="mt-2 text-emerald-800">
          {t("pricing.list.savedAgain")}
        </p>
      )}
    </section>
  );
}
