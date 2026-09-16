"use client";

import { useEffect, useRef, useState } from "react";
import { targetApiClient } from "@/services/api/targetClient";

type Policy = { id: string; rateBasisPoints: number; approved: boolean };
type Destination = {
  destinationVersionId: string;
  configuration: { displayName: string; bookingUrl: string };
  trackingStatus: "not_validated";
};
type Terms = {
  bookingDestinationId: string;
  financePolicyVersionId: string;
  attributionWindowDays: number;
};
type DraftRead = {
  revision: number;
  draft: null | {
    id: string;
    terms: Terms;
    destination: Destination | null;
    commission:
      | { status: "unavailable"; reason: string }
      | {
          status: "available";
          policyVersionId: string;
          policy: { percentageRate: string; rateBasisPoints: number };
        };
  };
};

/** Mount with a property/offer key so pending requests cannot cross resource selections. */
export function AffiliateOfferTermsEditor({
  propertyId,
  offerId,
}: {
  propertyId: string;
  offerId: string;
}) {
  const path = `/api/marketplace/properties/${encodeURIComponent(propertyId)}/offers/${encodeURIComponent(offerId)}/affiliate-draft`;
  const [loaded, setLoaded] = useState<DraftRead | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [destinationId, setDestinationId] = useState("");
  const [policyId, setPolicyId] = useState("");
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setLoaded(null);
    setError("");
    void Promise.all([
      targetApiClient.get<DraftRead>(path),
      targetApiClient.get<{ policies: Policy[] }>(
        `/api/marketplace/properties/${encodeURIComponent(propertyId)}/affiliate-policies`,
      ),
      targetApiClient.get<{ destinations: Destination[] }>(
        `/api/marketplace/properties/${encodeURIComponent(propertyId)}/affiliate-destinations`,
      ),
    ])
      .then(([draft, history, bookingPages]) => {
        if (!active) return;
        const approved = history.policies.filter((p) => p.approved);
        const commission = draft.draft?.commission;
        if (
          commission?.status === "available" &&
          !approved.some((p) => p.id === commission.policyVersionId)
        )
          approved.push({
            id: commission.policyVersionId,
            rateBasisPoints: commission.policy.rateBasisPoints,
            approved: true,
          });
        const available = [...bookingPages.destinations];
        const savedDestination = draft.draft?.destination;
        if (
          savedDestination &&
          !available.some((d) => d.destinationVersionId === savedDestination.destinationVersionId)
        )
          available.push(savedDestination);
        setDestinations(available);
        setDestinationId(savedDestination?.destinationVersionId ?? "");
        setPolicies(approved);
        setLoaded(draft);
        setPolicyId(commission?.status === "available" ? commission.policyVersionId : "");
        setDays(draft.draft ? String(draft.draft.terms.attributionWindowDays) : "");
      })
      .catch(() => {
        if (active) setError("Affiliate terms could not be loaded. Reload to try again.");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [path, propertyId, reload]);

  async function save() {
    if (
      busy ||
      !loaded ||
      !policies.some((p) => p.id === policyId) ||
      !destinations.some((d) => d.destinationVersionId === destinationId)
    )
      return;
    const windowDays = Number(days);
    if (
      !/^\d+$/.test(days) ||
      !Number.isSafeInteger(windowDays) ||
      windowDays < 1 ||
      windowDays > 104249991
    ) {
      setError("Enter a positive whole number of attribution days (maximum 104249991).");
      return;
    }
    const payload = {
      expectedRevision: loaded.revision,
      terms: {
        bookingDestinationId: destinationId,
        financePolicyVersionId: policyId,
        attributionWindowDays: windowDays,
      },
    };
    const serialized = JSON.stringify(payload);
    if (attempt.current?.payload !== serialized)
      attempt.current = { payload: serialized, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await targetApiClient.put(path, payload, {
        headers: { "Idempotency-Key": attempt.current.key },
      });
      attempt.current = null;
      setLoaded(null);
      setMessage(
        "Affiliate draft saved. This does not publish terms or change existing agreements.",
      );
      setReload((n) => n + 1);
    } catch {
      setError(
        "Save could not be confirmed. Retry the same selection, or reload to check for changes before editing again.",
      );
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Affiliate offer terms"
      className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3"
    >
      <h4 className="font-semibold text-gray-900">Affiliate offer terms</h4>
      <p className="text-sm text-gray-600">
        Commission applies to accommodation revenue, excluding taxes and extras. Earnings require a
        verified completed stay.
      </p>
      <p className="text-sm text-gray-600">
        These are draft terms. Booking setup must be verified before creators can join.
      </p>
      {busy && <p role="status">Loading or saving affiliate terms…</p>}
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
      {loaded && (
        <>
          {!loaded.draft && (
            <p className="text-sm text-gray-600">
              Choose a saved booking page, approved commission and attribution window to set up this
              offer.
            </p>
          )}
          <label className="block text-sm font-medium">
            Booking page
            <select
              aria-label="Booking page"
              value={destinationId}
              disabled={busy}
              onChange={(e) => setDestinationId(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-300 p-2"
            >
              <option value="">Choose a saved booking page</option>
              {destinations.map((d) => (
                <option key={d.destinationVersionId} value={d.destinationVersionId}>
                  {d.configuration.displayName}
                  {d.destinationVersionId === loaded.draft?.terms.bookingDestinationId
                    ? " (saved)"
                    : ""}
                </option>
              ))}
            </select>
          </label>
          {destinationId && (
            <p className="break-all text-sm text-gray-600">
              {
                destinations.find((d) => d.destinationVersionId === destinationId)?.configuration
                  .bookingUrl
              }
              {" — Tracking not validated"}
            </p>
          )}
          {!destinations.length && (
            <p className="text-sm text-gray-600">
              Save a booking page above, then reload these terms.
            </p>
          )}
          {loaded.draft && !loaded.draft.destination && (
            <p className="text-sm text-gray-600">
              The saved booking page is unavailable. Choose a saved page before saving a new draft.
            </p>
          )}
          {loaded.draft && (
            <p className="text-sm text-gray-600">
              Saved commission:{" "}
              {loaded.draft.commission.status === "available"
                ? `${loaded.draft.commission.policy.percentageRate}%`
                : "unavailable — select an approved rate"}
            </p>
          )}
          <label className="block text-sm font-medium">
            Approved commission rate
            <select
              aria-label="Approved commission rate"
              value={policyId}
              disabled={busy}
              onChange={(e) => setPolicyId(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-300 p-2"
            >
              <option value="">Choose an approved rate</option>
              {policies.map((p) => (
                <option key={p.id} value={p.id}>
                  {(p.rateBasisPoints / 100).toFixed(2)}%
                  {p.id === loaded.draft?.terms.financePolicyVersionId ? " (saved)" : ""}
                </option>
              ))}
            </select>
          </label>
          {!policies.length && (
            <p className="text-sm text-gray-600">
              Save and approve a commission rate above, then reload these terms.
            </p>
          )}
          <label className="block text-sm font-medium">
            Attribution window (days)
            <input
              aria-label="Attribution window (days)"
              inputMode="numeric"
              value={days}
              disabled={busy}
              onChange={(e) => setDays(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-300 p-2"
            />
          </label>
          <p className="text-sm text-gray-600">
            The last eligible creator click within this window receives credit for bookings at this
            hotel.
          </p>
          <button
            type="button"
            disabled={busy || !destinationId || !policyId || !days}
            onClick={() => void save()}
            className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Save affiliate draft
          </button>
        </>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setMessage("");
          setReload((n) => n + 1);
        }}
        className="block text-sm font-medium text-primary-600 disabled:opacity-50"
      >
        Reload affiliate terms
      </button>
    </section>
  );
}
