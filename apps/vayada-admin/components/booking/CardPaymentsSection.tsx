"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import {
  hotelCardPaymentsService,
  hotelCardPaymentsView,
  type HotelCardPaymentsState,
} from "@/services/api/cardPayments";

// The next PMS, as the image build passes it (VAY-2205); the legacy pms.vayada.com is frozen.
const PMS_FRONTEND_URL = process.env.NEXT_PUBLIC_PMS_FRONTEND_URL || "https://next-pms.vayada.com";

const status = (value: unknown) =>
  value && typeof value === "object" && typeof (value as { status?: unknown }).status === "number"
    ? (value as { status: number }).status
    : null;

function Item({
  state,
  title,
  note,
}: {
  state: "done" | "waiting" | "open";
  title: string;
  note: string;
}) {
  return (
    <li className="flex gap-3 px-4 py-3">
      <span className="mt-0.5 shrink-0" aria-hidden="true">
        {state === "done" ? (
          <CheckCircleIcon className="h-5 w-5 text-emerald-600" />
        ) : state === "waiting" ? (
          <ClockIcon className="h-5 w-5 text-amber-600" />
        ) : (
          <span className="block h-[18px] w-[18px] rounded-full border-2 border-gray-300" />
        )}
      </span>
      <div>
        <p className="text-sm text-gray-900">{title}</p>
        <p className={`text-xs ${state === "waiting" ? "text-amber-700" : "text-gray-500"}`}>
          {note}
        </p>
      </div>
    </li>
  );
}

/** Card payments for one hotel, for Vayada finance (VAY-2205 P2.2). Read only since VAY-2442
 * (Flamur, 2026-11-03): card works as soon as the hotel's own steps are done, with no Vayada
 * approval. The hotel's settings change publishes its prices again by itself (VAY-2304); this
 * page says when that couldn't happen. */
export default function CardPaymentsSection({ hotelId }: { hotelId: string }) {
  const [state, setState] = useState<HotelCardPaymentsState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await hotelCardPaymentsService.read(hotelId));
      setError(null);
    } catch (cause) {
      setError(
        status(cause) === 403
          ? "You need Vayada finance access to see this hotel's card payments."
          : "This hotel's card payments couldn't be loaded. Try again in a moment.",
      );
    }
  }, [hotelId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !state)
    return (
      <div className="max-w-3xl rounded-lg border border-gray-200 bg-white p-5 text-sm text-gray-600">
        {error}
      </div>
    );
  if (!state) return <p className="text-sm text-gray-500">Loading…</p>;

  const view = hotelCardPaymentsView(state);
  // The system publishes the prices again after a payment change (VAY-2304). They stay stale only
  // when it couldn't: rooms or rates changed too, or no way to pay is left.
  const saveNeeded = view.pricesSaveNeeded;

  return (
    <div className="max-w-3xl space-y-4">
      {saveNeeded && (
        <div
          role="status"
          className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm"
        >
          <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-semibold text-amber-900">
              The hotel&apos;s prices couldn&apos;t be published again by themselves.
            </p>
            <p className="text-amber-800">
              Its rooms or rates changed too, or it has no way left to take payment. Until the hotel
              saves its prices, its booking page takes no bookings.
            </p>
            <a
              href={`${PMS_FRONTEND_URL}/rooms`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-primary-700 hover:underline"
            >
              Open the hotel&apos;s Prices in the PMS
              <ArrowTopRightOnSquareIcon className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>
        </div>
      )}
      <section
        aria-label="Card payments"
        className="rounded-lg border border-gray-200 bg-white p-5"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Card payments</h2>
            <p className="mt-1 text-sm text-gray-600">
              {view.on && saveNeeded
                ? "Card is on, but this hotel's booking page takes no bookings until its prices are saved again."
                : view.on
                  ? "Guests can pay by card on this hotel's booking page. Card is charged when booking, or held and charged when the hotel accepts a request."
                  : "Guests can pay by card on this hotel's booking page as soon as the hotel finishes these steps. vayada doesn't need to approve it."}
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
              view.on ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-700"
            }`}
          >
            {view.on ? "On" : "Off"}
          </span>
        </div>
        <ul className="mt-4 divide-y divide-gray-200 rounded-lg border border-gray-200">
          <Item
            state={view.linked ? "done" : "open"}
            title="Payment account linked"
            note={
              view.linked
                ? "The hotel connected its Stripe account, or saved its bank account for vayada Payment, in its payment settings."
                : "Not yet. The hotel does this in its payment settings."
            }
          />
          <Item
            state={view.accountReady ? "done" : view.linked ? "waiting" : "open"}
            title="Ready to take cards"
            note={
              view.accountReady
                ? "All on."
                : "Not yet. The hotel still has to finish its Stripe setup, or save its bank account for vayada Payment."
            }
          />
          <Item
            state={view.hotelChoseCard ? "done" : "open"}
            title="Card chosen in the hotel's payment settings"
            note={
              view.hotelChoseCard
                ? "Payments are on, with card."
                : !view.currencyEligible
                  ? "The hotel's currency can't take card payments."
                  : "Not yet. The hotel turns on payments with card in its payment settings."
            }
          />
        </ul>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {error}
          </p>
        )}
        <p className="mt-4 text-xs text-gray-500">
          To stop card payments for this hotel, the hotel turns card off in its payment settings.
          Bookings already paid keep their payments, and their refunds still work.
        </p>
      </section>
    </div>
  );
}
