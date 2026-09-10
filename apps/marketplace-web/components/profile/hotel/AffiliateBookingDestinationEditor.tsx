"use client";

import { useEffect, useRef, useState } from "react";
import {
  parseAffiliateBookingDestinationConfiguration,
  type AffiliateTrackingPurpose,
} from "@vayada/domain-booking";
import { targetApiClient } from "@/services/api/targetClient";

type Destination = {
  destinationVersionId: string;
  configuration: { displayName: string; bookingUrl: string };
  trackingStatus: "not_validated";
  trackingReadiness?: { status: "pending" | "verified"; missing: AffiliateTrackingPurpose[] };
};
const trackingChecks: Record<AffiliateTrackingPurpose, string> = {
  referral_round_trip: "Match the creator link to the resulting booking",
  reservation_lifecycle: "Receive booking confirmations, changes and cancellations",
  stay_completion: "Confirm that the guest completed the stay",
  accommodation_revenue: "Identify accommodation revenue excluding taxes and extras",
};
export function AffiliateBookingDestinationEditor({ propertyId }: { propertyId: string }) {
  const path = `/api/marketplace/properties/${encodeURIComponent(propertyId)}/affiliate-destinations`;
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [bookingUrl, setBookingUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void targetApiClient
      .get<{ destinations: Destination[] }>(path)
      .then((result) => {
        if (active) setDestinations(result.destinations);
      })
      .catch(() => {
        if (active) setError("Booking pages could not be loaded. Reload to try again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, reload]);
  async function save() {
    if (saving || loading) return;
    const configuration = parseAffiliateBookingDestinationConfiguration({
      displayName,
      bookingUrl,
    });
    if (!configuration) {
      setError(
        "Enter a name and a complete HTTPS booking URL without sign-in details or a # fragment.",
      );
      return;
    }
    const payload = JSON.stringify(configuration);
    if (attempt.current?.payload !== payload)
      attempt.current = { payload, key: crypto.randomUUID() };
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await targetApiClient.post(path, configuration, {
        headers: { "Idempotency-Key": attempt.current.key },
      });
      attempt.current = null;
      setDisplayName("");
      setBookingUrl("");
      setMessage(
        "Booking page saved. Tracking still needs validation before affiliate links can go live.",
      );
      setReload((value) => value + 1);
    } catch {
      setError(
        "Save could not be confirmed. Retry the same details to confirm the saved booking page.",
      );
    } finally {
      setSaving(false);
    }
  }
  const busy = loading || saving;
  return (
    <section
      aria-label="Affiliate booking pages"
      className="mt-6 rounded-2xl border border-gray-200 bg-white p-5 space-y-4"
    >
      <div>
        <h3 className="text-lg font-semibold text-gray-900">Affiliate booking pages</h3>
        <p className="text-sm text-gray-600">
          Add the hotel booking page guests should use. It can be hosted by Vayada or another
          booking provider.
        </p>
        <p className="mt-1 text-sm text-gray-600">
          Saving a page does not validate tracking or activate affiliate links. Existing offer terms
          keep their original booking page.
        </p>
      </div>
      <label className="block text-sm font-medium text-gray-900">
        Booking page name
        <input
          aria-label="Booking page name"
          value={displayName}
          maxLength={120}
          disabled={busy}
          onChange={(event) => setDisplayName(event.target.value)}
          className="mt-1 block w-full rounded-lg border border-gray-300 p-2"
        />
      </label>
      <label className="block text-sm font-medium text-gray-900">
        Booking page URL
        <input
          aria-label="Booking page URL"
          inputMode="url"
          value={bookingUrl}
          maxLength={2048}
          disabled={busy}
          onChange={(event) => setBookingUrl(event.target.value)}
          placeholder="https://"
          className="mt-1 block w-full rounded-lg border border-gray-300 p-2"
        />
      </label>
      <button
        type="button"
        disabled={busy || !displayName.trim() || !bookingUrl}
        onClick={() => void save()}
        className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        Save booking page
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-green-700">
          {message}
        </p>
      )}
      {loading ? (
        <p role="status">Loading booking pages…</p>
      ) : destinations.length ? (
        <ul className="divide-y divide-gray-100">
          {destinations.map((destination) => (
            <li key={destination.destinationVersionId} className="py-3 space-y-1">
              <p className="font-medium text-gray-900">{destination.configuration.displayName}</p>
              <p className="break-all text-sm text-gray-600">
                {destination.configuration.bookingUrl}
              </p>
              <p className="text-sm text-amber-700">Tracking not validated</p>
              {destination.trackingReadiness?.status === "pending" &&
              destination.trackingReadiness.missing.length ? (
                <details className="text-sm text-gray-600">
                  <summary className="cursor-pointer font-medium">
                    What still needs verification
                  </summary>
                  <ul className="mt-2 list-disc pl-5 space-y-1">
                    {destination.trackingReadiness.missing.map((purpose) => (
                      <li key={purpose}>
                        {trackingChecks[purpose] ?? "An additional tracking check"}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2">
                    These checks need evidence from your booking or property-management system.
                    Saving a booking page cannot complete them.
                  </p>
                </details>
              ) : (
                <p className="text-sm text-gray-600">
                  Tracking verification details are unavailable.
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        !error && <p className="text-sm text-gray-500">No booking pages saved yet.</p>
      )}
      {destinations.length === 20 && (
        <p className="text-xs text-gray-500">Showing the 20 most recently saved booking pages.</p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => setReload((value) => value + 1)}
        className="text-sm font-medium text-primary-600 disabled:opacity-50"
      >
        Reload booking pages
      </button>
    </section>
  );
}
