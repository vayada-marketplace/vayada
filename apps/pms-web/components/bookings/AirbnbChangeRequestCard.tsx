"use client";
import type { BookingChangeRequest } from "@/services/bookings";
import { useTranslation } from "@/lib/i18n";

export function AirbnbChangeRequestCard({
  request,
  busy,
  onDecide,
}: {
  request: BookingChangeRequest;
  busy: boolean;
  onDecide: (action: "accept" | "decline") => void;
}) {
  const { t, locale } = useTranslation();
  const provider = request.providerRequest;
  if (!provider) return null;
  const money = (amount: number | null) =>
    amount === null || !provider.currency
      ? t("bookings.airbnb.unknown")
      : new Intl.NumberFormat(locale, { style: "currency", currency: provider.currency }).format(
          amount,
        );
  const guests = (adults: number | null, children: number | null) =>
    adults === null || children === null
      ? t("bookings.airbnb.unknown")
      : t("bookings.airbnb.guests", { adults, children });
  return (
    <section
      aria-label={t("bookings.airbnb.title")}
      aria-busy={busy}
      className="mb-4 rounded-xl border border-blue-200 bg-blue-50 p-5 text-sm text-blue-950"
    >
      <h2 className="font-semibold">{t("bookings.airbnb.title")}</h2>
      <p role="status" className="mt-1 text-blue-800">
        {t(`bookings.airbnb.state.${provider.state}`)}
      </p>
      <div className="my-4 grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="font-medium">{t("bookings.detail.current")}</h3>
          <p>
            {request.oldCheckIn} → {request.oldCheckOut}
          </p>
          <p>{guests(provider.oldAdults, provider.oldChildren)}</p>
          <p>{money(provider.oldTotal)}</p>
        </div>
        <div>
          <h3 className="font-medium">{t("bookings.detail.requested")}</h3>
          <p>
            {request.requestedCheckIn} → {request.requestedCheckOut}
          </p>
          <p>{guests(provider.requestedAdults, provider.requestedChildren)}</p>
          <p>{money(provider.newTotal)}</p>
        </div>
      </div>
      <p className="mb-4 font-medium">
        {t("bookings.detail.priceDifference", { difference: money(provider.priceDifference) })}
      </p>
      {(provider.state === "pending" || provider.state === "queued") && (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy || !provider.allowedActions.includes("accept")}
            onClick={() => onDecide("accept")}
            className="rounded-lg bg-blue-700 px-4 py-2 font-medium text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("bookings.detail.approveChange")}
          </button>
          <button
            type="button"
            disabled={busy || !provider.allowedActions.includes("decline")}
            onClick={() => onDecide("decline")}
            className="rounded-lg border border-blue-300 px-4 py-2 font-medium hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("bookings.detail.declineChange")}
          </button>
        </div>
      )}
      {provider.refreshAction && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onDecide(provider.refreshAction!)}
          className="rounded-lg border border-blue-300 px-4 py-2 font-medium hover:bg-blue-100 disabled:opacity-50"
        >
          {t("bookings.airbnb.checkStatus")}
        </button>
      )}
      {(provider.state === "pending" || provider.state === "queued") &&
        !provider.allowedActions.length && (
          <p className="mt-3 text-blue-800">{t("bookings.airbnb.disabled")}</p>
        )}
      {(provider.allowedActions.length > 0 || provider.state === "awaiting_confirmation") && (
        <p className="mt-3 text-blue-800">{t("bookings.airbnb.confirmationNote")}</p>
      )}
    </section>
  );
}
