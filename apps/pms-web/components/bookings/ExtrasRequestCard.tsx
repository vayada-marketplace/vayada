"use client";
import { useState } from "react";
import { CheckCircleIcon, CheckIcon, XCircleIcon } from "@heroicons/react/24/outline";
import { pricingCurrencyScale } from "@vayada/domain-pms";
import type { BookingExtrasRequest } from "@/services/bookings";
import { useTranslation } from "@/lib/i18n";

/** VAY-2360 part 3: the extras a guest asked for after booking, where the date-change request shows: blue
 * while it waits (Accept extras or Decline, with an optional reason for the guest), green once accepted, one
 * grey line once declined. Accepting doesn't change the booking's total: the hotel charges them at check-in. */
export function ExtrasRequestCard({
  request,
  guestName,
  busy,
  onDecide,
}: {
  request: BookingExtrasRequest;
  guestName: string;
  busy: boolean;
  onDecide: (decision: "accept" | "decline", reason?: string) => void;
}) {
  const { t, locale } = useTranslation();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const money = (minor: string, currency: string) =>
    new Intl.NumberFormat(locale, { style: "currency", currency }).format(
      Number(minor) / 10 ** (pricingCurrencyScale(currency) ?? 2),
    );
  const day = (value: string | null) =>
    value ? new Date(value).toLocaleDateString(locale, { day: "numeric", month: "short" }) : "";
  const counted = (count: number, one: string, many: string) =>
    count === 1 ? t(one) : t(many, { count });
  const how = (item: BookingExtrasRequest["items"][number]) => {
    const unit = money(item.unitMinor, item.currency);
    const guests = counted(item.guests, "bookings.extras.oneGuest", "bookings.extras.guests");
    const nights = counted(item.nights, "bookings.extras.oneNight", "bookings.extras.nights");
    return item.pricingModel === "per_stay"
      ? t("bookings.extras.perStay")
      : item.pricingModel === "per_night"
        ? `${t("bookings.extras.perNight", { amount: unit })} · ${nights}`
        : item.pricingModel === "per_guest"
          ? `${t("bookings.extras.perGuest", { amount: unit })} · ${guests}`
          : `${t("bookings.extras.perGuestNight", { amount: unit })} · ${guests} · ${nights}`;
  };
  const names = request.items.map((item) => item.name).join(", ");
  const guest = guestName || t("bookings.extras.theGuest");

  if (request.status === "declined")
    return (
      <p className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
        {t("bookings.extras.declined", { date: day(request.decidedAt), names, guest })}
      </p>
    );
  if (request.status !== "pending" && request.status !== "accepted") return null;
  const accepted = request.status === "accepted";
  const tone = accepted
    ? "border-green-200 bg-green-50 text-green-900"
    : "border-blue-200 bg-blue-50 text-blue-900";
  const sub = accepted ? "text-green-700" : "text-blue-700";
  const line = accepted ? "border-green-200" : "border-blue-200";
  return (
    <section
      aria-label={t("bookings.extras.title")}
      aria-busy={busy}
      className={`mb-4 rounded-xl border p-5 text-sm ${tone}`}
      data-testid="extras-request-card"
    >
      {accepted ? (
        <div>
          <p className="flex items-center gap-1.5 font-semibold">
            <CheckIcon className="h-4 w-4" aria-hidden="true" />
            {t("bookings.extras.accepted", { date: day(request.decidedAt) })}
          </p>
          <p className={`text-xs ${sub}`}>{t("bookings.extras.acceptedHint", { guest })}</p>
        </div>
      ) : (
        <div>
          <p className="font-semibold">{t("bookings.extras.title")}</p>
          <p className={`text-xs ${sub}`}>
            {t("bookings.extras.description", { guest, date: day(request.createdAt) })}
          </p>
        </div>
      )}
      <ul className="mt-3">
        {request.items.map((item) => (
          <li
            key={item.addonId}
            className={`flex items-start justify-between gap-3 border-t py-2 ${line}`}
          >
            <span className="min-w-0">
              <span className="block font-semibold">{item.name}</span>
              <span className={`block text-xs ${sub}`}>{how(item)}</span>
            </span>
            <span className="whitespace-nowrap font-semibold">
              {money(item.amountMinor, item.currency)}
            </span>
          </li>
        ))}
        <li className={`flex justify-between gap-3 border-t pt-2 font-semibold ${line}`}>
          <span>{t("bookings.extras.toCharge")}</span>
          <span className="font-bold">{money(request.totalMinor, request.currency)}</span>
        </li>
      </ul>
      {!accepted &&
        (declining ? (
          <div className="mt-4 flex flex-col gap-2">
            <label className="text-xs font-medium" htmlFor="extras-decline-reason">
              {t("bookings.extras.reason")}
            </label>
            <textarea
              id="extras-decline-reason"
              value={reason}
              maxLength={1000}
              onChange={(event) => setReason(event.target.value)}
              className="min-h-[72px] rounded-lg border border-gray-300 bg-white p-2 text-sm text-gray-900"
            />
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => onDecide("decline", reason.trim() || undefined)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                <XCircleIcon className="h-4 w-4" aria-hidden="true" />
                {t("bookings.extras.declineConfirm")}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDeclining(false)}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                {t("bookings.extras.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => onDecide("accept")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              <CheckCircleIcon className="h-4 w-4" aria-hidden="true" />
              {t("bookings.extras.accept")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDeclining(true)}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              {t("bookings.extras.decline")}
            </button>
          </div>
        ))}
    </section>
  );
}
