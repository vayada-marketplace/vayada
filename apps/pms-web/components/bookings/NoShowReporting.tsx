"use client";

import { useEffect, useState } from "react";
import { bookingsService } from "@/services/bookings";

type Status = Awaited<ReturnType<typeof bookingsService.getNoShowReport>>;
export function NoShowReporting({
  bookingId,
  onChanged,
  canRecordLocal,
}: {
  bookingId: string;
  onChanged: () => void;
  canRecordLocal: boolean;
}) {
  const [state, setState] = useState<Status | null>(null);
  const [localRecorded, setLocalRecorded] = useState(!canRecordLocal);
  const current = state ?? {
    eligible: false,
    reason: "Reporting status is unavailable. You can still record a local no-show.",
    localNoShow: localRecorded,
    status: "not_reported" as const,
    retryable: false,
    waivedFees: null,
  };
  const [confirm, setConfirm] = useState(false);
  const [report, setReport] = useState(false);
  const [fee, setFee] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () =>
      bookingsService
        .getNoShowReport(bookingId)
        .then((result) => {
          if (active) setState(result);
        })
        .catch(() => {
          if (active)
            setError("Could not load Booking.com reporting status. Refresh before reporting.");
        });
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [bookingId]);
  async function submit(retry = false) {
    if ((report || retry) && !state) return;
    const waivedFees = retry ? current.waivedFees : fee === "waive";
    if (retry && waivedFees === null) {
      setError("The previous fee choice is unavailable. Refresh before retrying.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (!current.localNoShow && !localRecorded) {
        await bookingsService.markNoShow(bookingId);
        setLocalRecorded(true);
        setState({ ...current, localNoShow: true });
      }
      if ((report || retry) && waivedFees !== null) {
        setState({
          ...current,
          localNoShow: true,
          status: "pending",
          reason: "Submission outcome is not yet known. Refresh before taking further action.",
        });
        setState(await bookingsService.reportNoShow(bookingId, waivedFees, retry));
      }
      try {
        setState(await bookingsService.getNoShowReport(bookingId));
      } catch {
        setError(
          report || retry
            ? "Reporting was requested, but refreshed status is unavailable. Check here again before taking action in the extranet."
            : "Local no-show saved. Reporting status is unavailable; Booking.com has not been notified by this action.",
        );
      }
      setConfirm(false);
      onChanged();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not complete the action. Refresh to check its status.",
      );
      // A failed reporting request must never cause the local no-show to run again.
      try {
        setState(await bookingsService.getNoShowReport(bookingId));
      } catch {
        /* keep last known local state */
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="mb-6 rounded-xl border border-gray-200 p-4 space-y-3"
      aria-label="No-show reporting"
    >
      <h2 className="font-semibold">No-show and Booking.com reporting</h2>
      <p className="text-sm">
        {state?.status === "pending"
          ? "Report pending — Booking.com reporting is not confirmed."
          : state?.status === "submitted"
            ? "Submitted to Channex — confirm Booking.com reporting in the extranet."
            : state?.status === "action_required"
              ? "Reporting needs attention."
              : state
                ? "Booking.com has not been notified by PMS."
                : "Loading reporting status…"}
      </p>
      {state?.reason && <p className="text-sm text-gray-600">{state.reason}</p>}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {current.status === "not_reported" &&
        ((canRecordLocal && !localRecorded) || current.localNoShow) &&
        !confirm && (
          <button
            type="button"
            disabled={busy || (current.localNoShow && !current.eligible)}
            onClick={() => {
              setConfirm(true);
              setReport(false);
              setFee("");
            }}
            className="rounded-lg border border-red-200 px-4 py-2 text-sm text-red-700 disabled:opacity-50"
          >
            {current.localNoShow ? "Report no-show to Booking.com" : "Record no-show"}
          </button>
        )}
      {confirm && (
        <div className="space-y-3 border-t pt-3">
          <p className="text-sm">
            {current.localNoShow
              ? "The local no-show is already recorded."
              : "Record the entire reservation as a no-show and release its occupied inventory?"}
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={report}
              disabled={busy || !current.eligible}
              onChange={(event) => setReport(event.target.checked)}
            />
            Also report the entire reservation to Booking.com. Booking.com may notify the guest.
          </label>
          {report && (
            <p className="text-sm text-gray-600">
              Booking.com checks its remaining reporting restrictions when the report is sent. A
              rejection will appear here.
            </p>
          )}
          {report && (
            <label className="block text-sm">
              No-show fee choice
              <select
                aria-label="No-show fee choice"
                value={fee}
                disabled={busy}
                onChange={(event) => setFee(event.target.value)}
                className="mt-1 block rounded-lg border p-2"
              >
                <option value="">Choose explicitly</option>
                <option value="retain">Do not waive the no-show fee</option>
                <option value="waive">Waive the no-show fee</option>
              </select>
              <span className="mt-2 block text-gray-600">
                This sends your fee choice to Booking.com. It does not charge a card or guarantee a
                commission outcome.
              </span>
            </label>
          )}
          {!report && <p className="text-sm">Booking.com will not be notified.</p>}
          <div className="flex gap-3">
            <button
              type="button"
              disabled={busy || (report && !fee) || (current.localNoShow && !report)}
              onClick={() => void submit()}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {busy ? "Saving…" : report ? "Confirm and report" : "Record locally only"}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {state?.retryable && state.waivedFees !== null && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit(true)}
          className="rounded-lg border px-4 py-2 text-sm"
        >
          Retry delivery with the same fee choice
        </button>
      )}
    </section>
  );
}
