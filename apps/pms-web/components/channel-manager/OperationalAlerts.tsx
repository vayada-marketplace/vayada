"use client";

import { useCallback, useEffect, useState } from "react";
import { channexService, type ChannexSnapshot, type ChannexAlert } from "@/services/channex";
import { channelManagerButtonClass as buttonClass } from "./ChannelManagerUi";

const descriptions: Record<string, [string, string]> = {
  booking_unmapped_room: [
    "A booking needs a room mapping",
    "Open channel settings and explicitly choose the correct room mapping. After saving it, retry this booking.",
  ],
  booking_unmapped_rate: [
    "A booking needs a rate mapping",
    "Open channel settings and explicitly choose the correct rate mapping. After saving it, retry this booking.",
  ],
  non_acked_booking: [
    "A booking delivery receipt is missing",
    "We will check durable processing before retrying the technical delivery receipt. This is not hotel acceptance of the reservation.",
  ],
  rate_error: [
    "A rate update was rejected",
    "Review your rates and channel settings, then retry availability and rates. Channex values will be checked after the update.",
  ],
  sync_error: [
    "A channel update failed",
    "Review channel settings and rate configuration, then retry availability and rates.",
  ],
  sync_warning: [
    "A channel update needs attention",
    "Review channel settings and rate configuration, then retry availability and rates.",
  ],
  disconnected_channel: [
    "A channel is disconnected",
    "Reconnect this channel in channel settings, then retry. We will check the connection and recover bookings, availability and rates.",
  ],
};

export function OperationalAlerts({
  snapshot,
  openSettings,
}: {
  snapshot: ChannexSnapshot;
  openSettings: () => Promise<void>;
}) {
  const [alerts, setAlerts] = useState<ChannexAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [corrected, setCorrected] = useState<Record<string, boolean>>({});
  const load = useCallback(async () => {
    try {
      setAlerts(await channexService.getAlerts());
      setError("");
    } catch {
      setError("Channel alerts could not be refreshed. Try again.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);
  const act = async (alert: ChannexAlert, action: "acknowledge" | "recover") => {
    setBusy(alert.id);
    setError("");
    try {
      await channexService.alertAction(alert.id, action, alert.recoveryRound);
      await load();
    } catch {
      setError(
        "The request could not be accepted. Refresh the alerts and check channel settings before trying again.",
      );
    } finally {
      setBusy("");
    }
  };
  return (
    <section
      className="mt-6 space-y-4 rounded-xl border border-gray-200 bg-white p-5"
      aria-label="Channel alerts"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-gray-950">Channel alerts</h2>
        <button className={buttonClass} type="button" onClick={() => void load()}>
          Refresh alerts
        </button>
      </div>
      <p className="text-sm text-gray-600">
        Marking an alert seen does not fix it. Recovery is verified separately. Channex confirmation
        does not confirm delivery to the booking website.
      </p>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {loading && (
        <p className="text-sm text-gray-500" role="status">
          Loading channel alerts…
        </p>
      )}
      {!loading && !alerts.length && !error && (
        <p className="text-sm text-gray-500">No channel alerts recorded.</p>
      )}
      {alerts.map((alert) => {
        const [title, guidance] = descriptions[alert.eventType] ?? [
          "Channel event",
          "Review channel settings.",
        ];
        const mapping = alert.eventType.startsWith("booking_unmapped");
        const disconnected = alert.eventType === "disconnected_channel";
        const booking = mapping || disconnected || alert.eventType === "non_acked_booking";
        const ari = !booking || disconnected;
        const pending = alert.recovery.some((job) => ["pending", "running"].includes(job.status));
        const allowed =
          (!booking || snapshot.capabilityModes.bookingSync === "mutating") &&
          (!ari || snapshot.capabilityModes.ariSync === "mutating");
        const resolved = Boolean(alert.resolvedAt);
        const automaticRetry = snapshot.sync[ari ? "ari" : "booking"].retryAfter;
        return (
          <article key={alert.id} className="rounded-lg border border-amber-200 p-4">
            <div className="flex flex-wrap justify-between gap-2">
              <h3 className="font-semibold text-gray-900">{title}</h3>
              <span className="text-sm">
                {resolved
                  ? "Recovery verified"
                  : alert.eventType === "sync_warning"
                    ? "Warning"
                    : "Needs attention"}
              </span>
            </div>
            <p className="mt-2 text-sm text-gray-700">{guidance}</p>
            <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {[
                ["Channel", alert.impact.channel ?? alert.impact.channelId],
                ["Booking", alert.impact.bookingId],
                ["Room type", alert.impact.roomTypeId],
                ["Rate plan", alert.impact.ratePlanId],
                ["From", alert.impact.dateFrom],
                ["To", alert.impact.dateTo],
              ].map(([label, value]) => (
                <div key={label} className="flex gap-2">
                  <dt className="text-gray-500">{label}:</dt>
                  <dd className="break-all">{value ?? "Unknown"}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-gray-500">
              First: {new Date(alert.firstOccurredAt).toLocaleString()} · Latest:{" "}
              {new Date(alert.lastOccurredAt).toLocaleString()} · {alert.occurrences} occurrence(s)
            </p>
            <p className="mt-2 text-sm" role="status">
              {resolved
                ? "Recovery completed and provider evidence was checked."
                : pending
                  ? "Recovery is running; this alert remains open."
                  : alert.recovery.length
                    ? "Review the recovery result below. The alert stays open until all checks pass."
                    : "No recovery queued."}
            </p>
            {!alert.recovery.length && automaticRetry && (
              <p className="text-sm text-gray-600">
                Property sync is retrying automatically at{" "}
                {new Date(automaticRetry).toLocaleString()}. This alert remains open until recovery
                is checked.
              </p>
            )}
            {alert.recovery.map((job, index) => (
              <p key={index} className="text-sm text-gray-600">
                {job.status.replaceAll("_", " ")} · attempt {job.attemptsMade} of {job.maxAttempts}
                {job.retryAfter
                  ? ` · next attempt ${new Date(job.retryAfter).toLocaleString()}`
                  : ""}
              </p>
            ))}
            {!resolved &&
              alert.recovery.some(
                (job) => job.status === "succeeded" && job.verified === false,
              ) && (
                <p className="mt-2 text-sm text-amber-800">
                  The affected scope could not be verified. Contact support with alert reference{" "}
                  {alert.id}.
                </p>
              )}
            {!resolved && (
              <>
                {(mapping || disconnected) && (
                  <label className="mt-3 flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={corrected[alert.id] ?? false}
                      onChange={(event) =>
                        setCorrected((current) => ({
                          ...current,
                          [alert.id]: event.target.checked,
                        }))
                      }
                    />
                    {mapping
                      ? "I saved the correct mapping in channel settings."
                      : "I completed reconnection in channel settings."}
                  </label>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => void openSettings()}
                    disabled={snapshot.capabilityModes.iframe !== "mutating"}
                  >
                    Open channel settings
                  </button>
                  {ari && (
                    <a href="/rooms" className={buttonClass}>
                      Review rates
                    </a>
                  )}
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => void act(alert, "acknowledge")}
                    disabled={Boolean(busy) || Boolean(alert.acknowledgedAt)}
                  >
                    {alert.acknowledgedAt ? "Seen — still open" : "Mark seen"}
                  </button>
                  <button
                    type="button"
                    className={`${buttonClass} bg-gray-950 text-white`}
                    onClick={() => void act(alert, "recover")}
                    disabled={
                      Boolean(busy) ||
                      pending ||
                      !allowed ||
                      alert.recoveryRound >= 3 ||
                      ((mapping || disconnected) && !corrected[alert.id])
                    }
                  >
                    Retry recovery
                  </button>
                </div>
                {alert.recoveryRound >= 3 && !pending && (
                  <p className="mt-2 text-sm text-amber-800">
                    Recovery limit reached. Contact support with alert reference {alert.id}.
                  </p>
                )}
              </>
            )}
          </article>
        );
      })}
    </section>
  );
}
