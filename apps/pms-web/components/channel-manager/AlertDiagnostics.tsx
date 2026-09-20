"use client";

import { useEffect, useState } from "react";
import { channexService, type ChannexAlertDiagnostics } from "@/services/channex";
import { channelManagerButtonClass as buttonClass } from "./ChannelManagerUi";

export function AlertDiagnostics({
  propertyId,
  alertId,
  round,
}: {
  propertyId: string;
  alertId: string;
  round: number;
}) {
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<ChannexAlertDiagnostics | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setData(null);
    setError(false);
    void channexService
      .getAlertDiagnostics(propertyId, alertId)
      .then((result) => {
        if (!active) return;
        if (result.alertId !== alertId || result.recoveryRound !== round) setError(true);
        else setData(result);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [open, refresh, propertyId, alertId, round]);
  return (
    <details className="mt-3 text-sm" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">Diagnostic details</summary>
      {open && (
        <div className="mt-2 space-y-2 break-words">
          <p>
            Historical Vayada records. These do not confirm current delivery to the booking website.
          </p>
          {error ? (
            <p role="status">
              Diagnostic details are unavailable. Refresh to check again. Alert reference: {alertId}
              .
            </p>
          ) : !data ? (
            <p role="status">Loading diagnostic details…</p>
          ) : (
            <>
              <p>
                Snapshot: {new Date(data.observedAt).toLocaleString()} · Recovery round{" "}
                {data.recoveryRound}
              </p>
              <p>Alert reference: {data.alertId}</p>
              {data.newerOccurrence && (
                <p>
                  A newer occurrence was recorded after recovery started. These jobs may not cover
                  it.
                </p>
              )}
              {data.latestReceipt ? (
                <>
                  <p>
                    Source: received Channex event · Receipt reference:{" "}
                    {data.latestReceipt.receiptId}
                  </p>
                  <p>
                    Occurred: {new Date(data.latestReceipt.occurredAt).toLocaleString()} · Last
                    received: {new Date(data.latestReceipt.receivedAt).toLocaleString()}
                  </p>
                </>
              ) : (
                <p>Receipt evidence is unavailable.</p>
              )}
              {data.linkedJobCount > data.recovery.length && (
                <p>
                  Some linked recovery evidence is unavailable or could not be matched to this
                  incident.
                </p>
              )}
              {!data.linkedJobCount && <p>No recovery job is linked to this incident.</p>}
              {data.recovery.map((job) => (
                <div key={job.jobId} className="border-l-2 border-gray-200 pl-3">
                  <p>
                    Source: Vayada recovery job ·{" "}
                    {
                      {
                        booking_import: "Booking processing",
                        sync_bookings: "Booking synchronization",
                        sync_ari: "Rate and availability synchronization",
                      }[job.operation]
                    }
                  </p>
                  <p>Job reference: {job.jobId}</p>
                  <p>
                    {job.status === "succeeded"
                      ? "Local job completed"
                      : job.status.replaceAll("_", " ")}{" "}
                    · {job.attemptsMade} attempt(s) · Updated:{" "}
                    {new Date(job.updatedAt).toLocaleString()}
                  </p>
                  {job.failure && <p>{job.failure}</p>}
                </div>
              ))}
              <p>Channex task details and channel response logs are unavailable in this view.</p>
            </>
          )}
          <button
            type="button"
            className={buttonClass}
            disabled={!data && !error}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh evidence
          </button>
        </div>
      )}
    </details>
  );
}
