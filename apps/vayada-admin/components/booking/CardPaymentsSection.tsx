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
import { usersService } from "@/services/api/users";

const PMS_FRONTEND_URL = process.env.NEXT_PUBLIC_PMS_FRONTEND_URL || "https://pms.vayada.com";

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

/** Card payments for one hotel, for Vayada finance (VAY-2205 P2.2, as drawn in Paper and approved
 * by Flamur on 2026-10-18): what the card needs, Vayada's approval, and turning card on or off.
 * Either change stales the hotel's published prices, so they must be saved again. */
export default function CardPaymentsSection({
  hotelId,
  hotelName,
}: {
  hotelId: string;
  hotelName: string;
}) {
  const [state, setState] = useState<HotelCardPaymentsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approver, setApprover] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"on" | "off" | null>(null);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState<"on" | "off" | null>(null);

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

  const approverId = state?.evidence?.acceptedByUserId ?? null;
  useEffect(() => {
    setApprover(null);
    if (!approverId) return;
    usersService
      .getUserById(approverId)
      .then((user) => setApprover(user.name || user.email))
      .catch(() => setApprover(null));
  }, [approverId]);

  if (error && !state)
    return (
      <div className="max-w-3xl rounded-lg border border-gray-200 bg-white p-5 text-sm text-gray-600">
        {error}
      </div>
    );
  if (!state) return <p className="text-sm text-gray-500">Loading…</p>;

  const view = hotelCardPaymentsView(state);
  const change = async (to: "on" | "off") => {
    setConfirm(null);
    setBusy(true);
    setError(null);
    try {
      if (to === "on") await hotelCardPaymentsService.turnOn(state);
      else await hotelCardPaymentsService.turnOff(state.propertyId, state.evidence!.evidenceId);
      setChanged(to);
    } catch (cause) {
      setError(
        status(cause) === 403
          ? "Turning card payments on or off needs Vayada finance manage rights."
          : status(cause) === 409
            ? "The hotel's Stripe account changed meanwhile. Check it again, then retry."
            : "That didn't go through. Try again in a moment.",
      );
    } finally {
      setBusy(false);
      await load();
    }
  };
  const when = (iso: string) =>
    new Date(iso).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <div className="max-w-3xl space-y-4">
      {changed && (
        <div
          role="status"
          className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm"
        >
          <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-semibold text-amber-900">
              {changed === "on"
                ? "Card payments are on. The hotel's prices must be saved again."
                : "Card payments are off. The hotel's prices must be saved again."}
            </p>
            <p className="text-amber-800">
              Until someone saves them, this hotel&apos;s booking page takes no bookings.
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
              {view.on
                ? "Guests can pay by card on this hotel's booking page. Card is charged when booking, or held and charged when the hotel accepts a request."
                : "Guests can pay by card on this hotel's booking page once its Stripe account is ready and vayada approves it."}
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
            title="Stripe account linked"
            note={
              view.linked
                ? "The hotel connected its own Stripe account in its payment settings."
                : "Not yet. The hotel connects it in its payment settings."
            }
          />
          <Item
            state={view.stripeReady ? "done" : view.linked ? "waiting" : "open"}
            title="Charges, payouts and card payments on in Stripe"
            note={
              view.stripeReady
                ? "All on."
                : "Not yet. The hotel still has to finish its Stripe setup."
            }
          />
          <Item
            state={view.approval ? "done" : "open"}
            title="vayada's approval"
            note={
              view.approval
                ? `Given ${when(view.approval.acceptedAt)}${approver ? ` by ${approver}` : ""}.`
                : changed === "off"
                  ? "Not given. Turning card payments on gives it again."
                  : "Not given. You give it by turning card payments on."
            }
          />
        </ul>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {view.on ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirm("off")}
                className="rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                Turn off card payments
              </button>
              <span className="text-xs text-gray-500">
                Bookings already paid keep their payments, and their refunds still work.
              </span>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={busy || !view.canTurnOn}
                onClick={() => setConfirm("on")}
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-40"
              >
                Turn on card payments
              </button>
              <span className="text-xs text-gray-500">
                {view.canTurnOn
                  ? "You'll confirm it as vayada's approval."
                  : "Possible once the hotel's Stripe account is ready."}
              </span>
            </>
          )}
        </div>
      </section>
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Turn ${confirm} card payments for ${hotelName}?`}
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
          >
            <h3 className="text-lg font-semibold text-gray-900">
              Turn {confirm} card payments for {hotelName}?
            </h3>
            <p className="mt-2 text-sm text-gray-600">
              {confirm === "on"
                ? "This is vayada's approval. You confirm that you checked the hotel's Stripe account and that it may take card payments on its booking page. Your name and the time are recorded."
                : "Guests can no longer pay by card. Bookings already paid keep their payments, and their refunds still work. vayada's approval is withdrawn; turning card on again needs a new one."}
            </p>
            <div className="mt-4 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <ExclamationTriangleIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
              <p>
                {confirm === "on"
                  ? "The hotel's prices must be saved again before its booking page takes bookings. Tell the hotel first."
                  : "The hotel's prices must be saved again before its booking page takes bookings, pay at property included. Rates that only take card stop selling."}
              </p>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => change(confirm)}
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white ${
                  confirm === "on"
                    ? "bg-primary-600 hover:bg-primary-700"
                    : "bg-red-600 hover:bg-red-700"
                }`}
              >
                Turn {confirm} card payments
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
