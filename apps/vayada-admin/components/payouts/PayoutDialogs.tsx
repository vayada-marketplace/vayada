"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui";
import {
  formatDay,
  formatMinor,
  needsApproval,
  today,
  vayadaPayoutsService,
  type PayoutBankDetails,
  type PayoutDestination,
  type PayoutHotel,
  type PayoutMode,
} from "@/services/api/vayadaPayouts";

const COUNTRIES: Record<string, string> = { ID: "Indonesia", LK: "Sri Lanka" };
export const countryName = (code: string) => COUNTRIES[code] ?? code;

const inputClass =
  "mt-1 w-full px-3 py-2 text-[13px] border border-gray-200 rounded-lg bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-200";
const primaryClass =
  "px-4 py-2 text-[13px] font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed";
const secondaryClass =
  "px-4 py-2 text-[13px] font-medium rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40";

/** The server's error code and message, read structurally (VAY-2169: never instanceof). */
export function errorOf(error: unknown): {
  status?: number;
  code?: string;
  message: string;
  payNowMinor?: string;
} {
  const value = error as { status?: number; data?: Record<string, unknown>; message?: string };
  const data = value?.data ?? {};
  return {
    status: value?.status,
    code: typeof data.code === "string" ? data.code : undefined,
    message:
      typeof data.message === "string" ? data.message : (value?.message ?? "Something went wrong."),
    payNowMinor: typeof data.payNowMinor === "string" ? data.payNowMinor : undefined,
  };
}

/** The hotel's bank account: masked until an operator asks, and every look is audited. Only the
 * account the operator expects is shown; a changed account says so instead. Details revealed for
 * one account are never shown under another (the hotel may replace it while the page is open). */
export function BankDetails({
  propertyId,
  destination,
  autoReveal = false,
  revealable = true,
  onRevealed,
}: {
  propertyId: string;
  destination: PayoutDestination | null;
  autoReveal?: boolean;
  /** False for an account staff haven't approved yet: its details open only to approve it (P7). */
  revealable?: boolean;
  onRevealed?: () => void;
}) {
  const [revealed, setRevealed] = useState<PayoutBankDetails | null>(null);
  const details = revealed && revealed.destinationId === destination?.id ? revealed : null;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reveal = async () => {
    if (!destination) return;
    setLoading(true);
    setError(null);
    try {
      setRevealed(await vayadaPayoutsService.revealBankDetails(propertyId, destination.id));
      onRevealed?.();
    } catch (failure) {
      setError(errorOf(failure).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (autoReveal) void reveal();
    // Reveal once when shown for sending; a click reveals otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoReveal]);
  if (!destination)
    return (
      <p className="text-[13px] text-amber-700">
        No payout account yet. The hotel adds it in Booking Admin under Payments.
      </p>
    );
  const rows: [string, string | undefined][] = details
    ? [
        ["Account holder", details.accountHolder],
        ["Account number", details.accountNumber],
        ["Bank", details.bankName],
        ["Bank code", details.bankCode],
        ["Branch code", details.branchCode],
        ["SWIFT / BIC", details.bicSwift],
        ["Holder address", details.holderAddress],
      ]
    : [];
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-gray-700">
          {countryName(destination.countryCode)} · account ending{" "}
          <span className="font-mono">{destination.accountLast4}</span>
        </p>
        {!details && !autoReveal && revealable && (
          <button
            type="button"
            onClick={reveal}
            disabled={loading}
            className="shrink-0 px-3 py-1.5 text-[12px] font-medium rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {loading ? "Opening…" : "Show bank details"}
          </button>
        )}
      </div>
      {loading && autoReveal && <p className="mt-2 text-[12px] text-gray-500">Opening…</p>}
      {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
      {details && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          {rows
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-gray-500">{label}</dt>
                <dd className="text-gray-900 font-medium break-words select-all">{value}</dd>
              </div>
            ))}
        </dl>
      )}
      {details && (
        <p className="mt-2 text-[11px] text-gray-400">
          Shown to you just now; this look is recorded.
        </p>
      )}
    </div>
  );
}

type StartedPayout = {
  id: string;
  amountMinor: string;
  /** The account it was started for; an older one if the hotel replaced it since (P7). */
  destinationId?: string;
};

export type PayoutTarget = {
  hotel: PayoutHotel;
  /** A payout already started (resume): straight to sending it. */
  started?: StartedPayout;
};

/** Paying a hotel in two steps. Start: exactly what is owed comes off the hotel's balance before
 * any money moves, so nobody else can pay it. Send: by Wise or the bank, to the account shown,
 * then mark it sent with the transfer's reference. Not sent after all: cancel it. */
export function PayoutModal({
  target,
  mode,
  cutoff,
  onClose,
  onChanged,
}: {
  target: PayoutTarget | null;
  mode: PayoutMode;
  cutoff: string;
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const [started, setStarted] = useState<StartedPayout | null>(null);
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState(today());
  const [sent, setSent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    setStarted(target?.started ?? null);
    setReference("");
    setPaidOn(today());
    setSent(false);
    setError(null);
    setCancelling(false);
  }, [target]);
  if (!target) return null;
  const { hotel } = target;
  // P7: the hotel replaced the account after this payout started. Its details were wiped, and the
  // account in use now is not where this payout was meant to go.
  const accountReplaced =
    started?.destinationId !== undefined && started.destinationId !== hotel.destination?.id;
  const unapproved = needsApproval(hotel.destination);
  const amountMinor = started?.amountMinor ?? hotel.payNowMinor;
  const amount = formatMinor(amountMinor, hotel.currency);
  const run = async (work: () => Promise<void>) => {
    setSaving(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      const problem = errorOf(failure);
      setError(
        problem.code === "payout_amount_changed" && problem.payNowMinor
          ? `What ${hotel.name} is owed changed to ${formatMinor(problem.payNowMinor, hotel.currency)}. Close this and check again.`
          : problem.message,
      );
    } finally {
      setSaving(false);
    }
  };
  const start = () =>
    run(async () => {
      if (!hotel.destination) return;
      const { payoutId } = await vayadaPayoutsService.start(hotel.propertyId, {
        mode,
        currency: hotel.currency,
        cutoff,
        amountMinor: hotel.payNowMinor,
        destinationId: hotel.destination.id,
      });
      setStarted({
        id: payoutId,
        amountMinor: hotel.payNowMinor,
        destinationId: hotel.destination.id,
      });
    });
  const markSent = () =>
    run(async () => {
      if (!started) return;
      await vayadaPayoutsService.markSent(hotel.propertyId, started.id, {
        reference: reference.trim(),
        paidOn,
      });
      onChanged(`Paid ${amount} to ${hotel.name}.`);
    });
  const cancel = () =>
    run(async () => {
      if (!started) return;
      await vayadaPayoutsService.markReturned(hotel.propertyId, started.id, "Not sent");
      onChanged(`Cancelled the payout to ${hotel.name}; it is owed again.`);
    });
  // Closing after starting keeps the payout started: the list offers to finish it.
  const close = () => (started ? onChanged("") : onClose());

  return (
    <Modal isOpen onClose={close} title={started ? "Send payout" : "Pay hotel"} size="md">
      <div className="space-y-4 text-[13px]">
        {mode === "test" && (
          <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-[12px] text-amber-800">
            Test mode: Stripe test money. Record it to check the flow, but don&apos;t send real
            money.
          </p>
        )}
        <div className="rounded-xl border border-gray-200 bg-gray-50/80 px-4 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500">
            {started ? `Send to ${hotel.name}` : `${hotel.name} is owed`}
          </p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{amount}</p>
          <p className="mt-0.5 text-[12px] text-gray-500">
            {`For stays checked out by ${formatDay(cutoff, true)}`}
          </p>
        </div>

        {!started ? (
          <>
            <div className="rounded-xl border border-gray-200 px-4 py-3">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-gray-500">
                Payout account
              </p>
              <BankDetails
                propertyId={hotel.propertyId}
                destination={hotel.destination}
                revealable={!unapproved}
              />
              {unapproved && (
                <p className="mt-2 text-[12px] text-amber-700">
                  Approve this bank account before paying out to it.
                </p>
              )}
            </div>
            <ol className="space-y-1.5 text-[12px] text-gray-600 list-decimal pl-4">
              <li>Start the payout: the amount comes off the hotel&apos;s balance.</li>
              <li>Send it by Wise or the bank to the account shown next.</li>
              <li>Mark it sent with the transfer reference.</li>
            </ol>
          </>
        ) : (
          <>
            {accountReplaced ? (
              <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12px] text-amber-800">
                The hotel replaced this bank account after this payout was started. If the money
                hasn&apos;t gone out, cancel it and pay the new account once it&apos;s approved.
              </p>
            ) : (
              <div className="rounded-xl border border-gray-200 px-4 py-3">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-gray-500">
                  Send to this account
                </p>
                <BankDetails
                  propertyId={hotel.propertyId}
                  destination={hotel.destination}
                  autoReveal
                />
              </div>
            )}
            <label className="block">
              <span className="text-[12px] font-medium text-gray-700">Transfer reference</span>
              <input
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                maxLength={200}
                placeholder="Wise transfer ID or bank reference"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="text-[12px] font-medium text-gray-700">Paid on</span>
              <input
                type="date"
                value={paidOn}
                max={today()}
                onChange={(event) => setPaidOn(event.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={sent}
                onChange={(event) => setSent(event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300"
              />
              <span className="text-gray-700">
                {accountReplaced
                  ? `I sent exactly ${amount} to the account this payout was started for.`
                  : hotel.destination
                    ? `I sent exactly ${amount} to the account ending ${hotel.destination.accountLast4}.`
                    : `I sent exactly ${amount}.`}
              </span>
            </label>
          </>
        )}

        {error && <p className="text-[12px] text-red-600">{error}</p>}
        {cancelling ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5">
            <p className="text-[12px] text-red-800">
              {`Cancel this payout? Only if nothing was sent: ${hotel.name} is owed ${amount} again.`}
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={() => setCancelling(false)} className={secondaryClass}>
                Keep it
              </button>
              <button
                type="button"
                onClick={cancel}
                disabled={saving}
                className="px-4 py-2 text-[13px] font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-40"
              >
                Cancel payout
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            {started ? (
              <>
                <button
                  type="button"
                  onClick={() => setCancelling(true)}
                  className={`${secondaryClass} mr-auto`}
                >
                  Not sent? Cancel
                </button>
                <button type="button" onClick={close} className={secondaryClass}>
                  Later
                </button>
                <button
                  type="button"
                  onClick={markSent}
                  disabled={saving || !sent || !reference.trim() || !paidOn}
                  className={primaryClass}
                >
                  {saving ? "Saving…" : "Mark as sent"}
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={close} className={secondaryClass}>
                  Close
                </button>
                <button
                  type="button"
                  onClick={start}
                  disabled={saving || !hotel.destination || unapproved}
                  className={primaryClass}
                >
                  {saving ? "Starting…" : `Start payout of ${amount}`}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** The bank sent a payout back: the hotel is owed it again. */
export function ReturnPayoutModal({
  propertyId,
  payout,
  onClose,
  onReturned,
}: {
  propertyId: string;
  payout: { id: string; amountMinor: string; currency: string; reference: string | null } | null;
  onClose: () => void;
  onReturned: () => void;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!payout) return null;
  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await vayadaPayoutsService.markReturned(propertyId, payout.id, reason.trim());
      setReason("");
      onReturned();
    } catch (failure) {
      setError(errorOf(failure).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal isOpen onClose={onClose} title="Payout returned" size="sm">
      <div className="space-y-4 text-[13px]">
        <p className="text-gray-700">
          {`${formatMinor(payout.amountMinor, payout.currency)} (${payout.reference ?? "no reference"}) came back from the bank. The hotel is owed it again and it shows in the next payout.`}
        </p>
        <label className="block">
          <span className="text-[12px] font-medium text-gray-700">Why it came back</span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            placeholder="For example: account closed"
            className={inputClass}
          />
        </label>
        {error && <p className="text-[12px] text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={secondaryClass}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !reason.trim()}
            className={primaryClass}
          >
            {saving ? "Saving…" : "Mark returned"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** P7: Vayada staff approve a hotel's payout account after checking it; until then no payout goes
 * to it (card payments keep working). Shows what was saved and when, and whether it replaced an
 * earlier account; the bank details open on request, audited like every look. */
export function ApproveAccountModal({
  propertyId,
  hotelName,
  destination,
  onClose,
  onApproved,
}: {
  propertyId: string;
  hotelName: string;
  destination: PayoutDestination | null;
  onClose: () => void;
  onApproved: (message: string) => void;
}) {
  const [checked, setChecked] = useState(false);
  const [looked, setLooked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setChecked(false);
    setLooked(false);
    setError(null);
  }, [destination]);
  if (!destination) return null;
  const approve = async () => {
    setSaving(true);
    setError(null);
    try {
      await vayadaPayoutsService.approveBankAccount(propertyId, destination.id);
      onApproved(
        `Approved the bank account ending ${destination.accountLast4} for ${hotelName}. Payouts can go to it now.`,
      );
    } catch (failure) {
      const problem = errorOf(failure);
      setError(
        problem.code === "payout_destination_changed"
          ? `${hotelName} changed its bank account again. Close this and check the new one.`
          : problem.message,
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal isOpen onClose={onClose} title="Approve bank account" size="md">
      <div className="space-y-4 text-[13px]">
        <p className="text-gray-700">
          {`${hotelName} ${destination.replaced ? "replaced its bank account" : "saved a bank account"} on ${formatDay(destination.savedAt)}. Check it before any payout goes to it. Card payments keep working meanwhile.`}
        </p>
        <div className="rounded-xl border border-gray-200 px-4 py-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <p className="text-[11px] font-medium uppercase tracking-wider text-gray-500">
              {`Saved ${formatDay(destination.savedAt)}`}
            </p>
            {destination.replaced && (
              <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800">
                Replaced
              </span>
            )}
          </div>
          <BankDetails
            propertyId={propertyId}
            destination={destination}
            onRevealed={() => setLooked(true)}
          />
          {!looked && (
            <p className="mt-2 text-[12px] text-gray-500">
              Open the bank details to check them before approving.
            </p>
          )}
        </div>
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-300"
          />
          <span className="text-gray-700">
            {`I checked that this account belongs to ${hotelName}.`}
          </span>
        </label>
        {error && <p className="text-[12px] text-red-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={secondaryClass}>
            Cancel
          </button>
          <button
            type="button"
            onClick={approve}
            disabled={saving || !checked || !looked}
            className={primaryClass}
          >
            {saving ? "Approving…" : "Approve bank account"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The amber "needs approval" chip for a saved account no payout may go to yet (P7). */
export function NeedsApproval({ destination }: { destination: PayoutDestination }) {
  return (
    <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800">
      {destination.replaced ? "New bank account – needs approval" : "Bank account – needs approval"}
    </span>
  );
}
