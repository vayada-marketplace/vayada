"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { StayExtra, StayExtras, StayExtrasRequest } from "@/lib/bookingStay";
import { resolveLocale } from "@/lib/utils";

const CHECK = "m4.5 12.75 6 6 9-13.5";
const PLUS = "M12 4.5v15m7.5-7.5h-15";
const CLOCK = "M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z";

function Glyph({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      className="h-[15px] w-[15px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
    >
      <path d={d} />
    </svg>
  );
}

/** VAY-2360 part 3: "Add to your stay" under the ticket. The guest picks extras and sends one request; we
 * confirm or decline it by email, and the guest pays at the hotel (nothing is charged online). One request
 * waits at a time. */
export default function ConfirmationExtras({
  extras,
  formatMoney,
  onRequest,
}: {
  extras: StayExtras;
  formatMoney: (minor: string, currency: string) => string;
  onRequest: (addonIds: string[]) => Promise<StayExtrasRequest | null>;
}) {
  const t = useTranslations("confirmation.extras");
  const locale = useLocale();
  const [selected, setSelected] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sent, setSent] = useState<StayExtrasRequest | null>(null);
  const request = sent ?? extras.request;
  const waiting = request?.status === "pending";
  const requested = new Set(waiting ? request.items.map((item) => item.addonId) : []);
  const accepted = request?.status === "accepted" ? request.items.map((item) => item.addonId) : [];
  const offered = extras.offered.filter((offer) => !accepted.includes(offer.addonId));
  if (offered.length === 0 && !request) return null;
  const picked = offered.filter((offer) => selected.includes(offer.addonId));
  const unit = (offer: StayExtra) =>
    offer.pricingModel === "per_stay"
      ? null
      : t(`unit.${offer.pricingModel}`, { amount: formatMoney(offer.unitMinor, offer.currency) });
  const names = (items: StayExtra[]) => items.map((item) => item.name).join(", ");
  const status =
    request?.status === "pending"
      ? t("pending", {
          date: new Date(request.createdAt).toLocaleDateString(resolveLocale(locale), {
            day: "numeric",
            month: "short",
          }),
        })
      : request?.status === "accepted"
        ? t("accepted", {
            names: names(request.items),
            amount: formatMoney(request.totalMinor, request.currency),
          })
        : request?.status === "declined"
          ? t("declined", { names: names(request.items) })
          : null;
  const send = async () => {
    setSending(true);
    setFailed(false);
    try {
      const created = await onRequest(picked.map((offer) => offer.addonId));
      if (!created) throw new Error("No request came back.");
      setSent(created);
      setSelected([]);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <section
      aria-labelledby="extras-title"
      className="flex flex-col gap-2.5"
      data-testid="confirmation-extras"
    >
      <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
        <h2 id="extras-title" className="text-sm font-semibold text-gray-700">
          {t("title")}
        </h2>
        <div className="flex flex-wrap gap-2">
          {offered.map((offer) => {
            const asked = requested.has(offer.addonId);
            const on = selected.includes(offer.addonId);
            return (
              <button
                key={offer.addonId}
                type="button"
                aria-pressed={asked || on}
                disabled={waiting || sending}
                onClick={() =>
                  setSelected((current) =>
                    current.includes(offer.addonId)
                      ? current.filter((id) => id !== offer.addonId)
                      : [...current, offer.addonId],
                  )
                }
                className={`flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-colors ${
                  asked
                    ? "border-amber-200 bg-amber-50 text-amber-800"
                    : on
                      ? "border-green-600 bg-green-50 text-green-800"
                      : "border-gray-300 bg-white text-gray-900 hover:bg-gray-50 disabled:opacity-60"
                }`}
              >
                <Glyph d={asked ? CLOCK : on ? CHECK : PLUS} />
                {asked ? `${offer.name} · ${t("requested")}` : offer.name}
              </button>
            );
          })}
        </div>
      </div>
      {picked.length > 0 && !waiting && (
        <div className="flex flex-col gap-3 rounded-[14px] border border-gray-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-sm font-semibold text-gray-900">
              {picked
                .map((offer) =>
                  [
                    offer.name,
                    formatMoney(offer.amountMinor, offer.currency),
                    unit(offer) && `(${unit(offer)})`,
                  ]
                    .filter(Boolean)
                    .join(" "),
                )
                .join(" · ")}
            </p>
            <p className="text-[13px] text-gray-500">{t("hint")}</p>
          </div>
          <button
            type="button"
            onClick={send}
            disabled={sending}
            className="h-10 shrink-0 rounded-full bg-primary-700 px-5 text-sm font-semibold text-white hover:bg-primary-800 disabled:opacity-60"
          >
            {sending ? t("sending") : t("send")}
          </button>
        </div>
      )}
      {failed && (
        <p role="alert" className="text-sm text-error-700">
          {t("failed")}
        </p>
      )}
      {status && (
        <p
          role="status"
          className={`text-sm ${request?.status === "accepted" ? "text-green-800" : "text-gray-600"}`}
        >
          {status}
        </p>
      )}
    </section>
  );
}
