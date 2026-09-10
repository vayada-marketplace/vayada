"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { targetApiClient } from "@/services/api/targetClient";

type Policy = { id: string; rateBasisPoints: number; approved: boolean; createdAt: string };
const displayRate = (rate: number) => (rate / 100).toFixed(2);
export function AffiliateCommissionEditor({ propertyId }: { propertyId: string }) {
  const path = `/api/marketplace/properties/${encodeURIComponent(propertyId)}/affiliate-policies`;
  const [rate, setRate] = useState("");
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const attempt = useRef<{ rate: string; key: string } | null>(null);
  const approvalKeys = useRef(new Map<string, string>());
  const load = useCallback(async () => {
    const result = await targetApiClient.get<{ policies: Policy[] }>(path);
    setPolicies(result.policies);
  }, [path]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void targetApiClient
      .get<{ policies: Policy[] }>(path)
      .then((result) => {
        if (active) setPolicies(result.policies);
      })
      .catch(() => {
        if (active) setError("Commission rates could not be loaded. Try again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path]);
  async function refresh() {
    setLoading(true);
    setError("");
    try {
      await load();
    } catch {
      setError("Commission rates could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }
  async function save() {
    if (busy) return;
    if (!/^(?:0|[1-9]\d?|100)(?:\.\d{1,2})?$/.test(rate) || Number(rate) > 100) {
      setError("Enter a percentage from 0 to 100, with up to two decimal places.");
      return;
    }
    const canonical = Number(rate).toFixed(2);
    if (attempt.current?.rate !== canonical)
      attempt.current = { rate: canonical, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await targetApiClient.post(
        path,
        { percentageRate: canonical },
        { headers: { "Idempotency-Key": attempt.current.key } },
      );
      setMessage(`${canonical}% saved as a draft. Review it below before approving.`);
      setRate("");
      attempt.current = null;
      await load();
    } catch {
      setError("Could not complete the save or refresh. Retry to confirm the saved rates.");
    } finally {
      setBusy(false);
    }
  }
  async function approve(policy: Policy) {
    if (busy) return;
    const key = approvalKeys.current.get(policy.id) ?? crypto.randomUUID();
    approvalKeys.current.set(policy.id, key);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await targetApiClient.post(`${path}/${encodeURIComponent(policy.id)}/approve`, undefined, {
        headers: { "Idempotency-Key": key },
      });
      setMessage(
        `${displayRate(policy.rateBasisPoints)}% approved. Existing agreements keep their original rate.`,
      );
      setConfirmId(null);
      await load();
    } catch {
      setError("Could not complete approval or refresh. Reload the rates before trying again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Affiliate commission rates"
      className="mt-6 rounded-2xl border border-gray-200 bg-white p-5 space-y-4"
    >
      <div>
        <h3 className="text-lg font-semibold text-gray-900">Affiliate commission rates</h3>
        <p className="text-sm text-gray-600">
          Choose a percentage of accommodation revenue, excluding taxes and extras. Earnings require
          a verified completed stay.
        </p>
        <p className="mt-1 text-sm text-gray-500">
          Approving a rate does not activate creator links or change existing agreements.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm font-medium text-gray-900">
          Commission (%)
          <input
            type="text"
            inputMode="decimal"
            value={rate}
            disabled={busy || loading}
            onChange={(event) => setRate(event.target.value)}
            className="mt-1 block w-40 rounded-lg border border-gray-300 px-3 py-2"
            aria-describedby="commission-rate-help"
          />
        </label>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || loading || !rate}
          className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Please wait…" : "Save draft rate"}
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy || loading}
          className="text-sm font-medium text-primary-700 disabled:opacity-50"
        >
          Reload rates
        </button>
      </div>
      <p id="commission-rate-help" className="text-xs text-gray-500">
        No rate is selected automatically. You can use up to two decimal places.
      </p>
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
        <p role="status" className="text-sm text-gray-500">
          Loading commission rates…
        </p>
      ) : policies.length === 0 ? (
        <p className="text-sm text-gray-500">No commission rates saved yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {policies.map((policy) => (
            <li key={policy.id} className="py-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <span className="font-semibold text-gray-900">
                  {displayRate(policy.rateBasisPoints)}%
                </span>
                <span className="ml-3 text-sm text-gray-600">
                  {policy.approved ? "Approved" : "Draft"}
                </span>
              </div>
              {!policy.approved &&
                (confirmId === policy.id ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm">
                      Approve {displayRate(policy.rateBasisPoints)}% on accommodation only?
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void approve(policy)}
                      className="text-sm font-semibold text-primary-700 disabled:opacity-50"
                    >
                      Confirm approval
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmId(null)}
                      className="text-sm text-gray-600"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={busy || loading}
                    onClick={() => setConfirmId(policy.id)}
                    className="text-sm font-semibold text-primary-700 disabled:opacity-50"
                  >
                    Review rate
                  </button>
                ))}
            </li>
          ))}
        </ul>
      )}
      {policies.length === 20 && (
        <p className="text-xs text-gray-500">Showing the 20 most recently saved rates.</p>
      )}
    </section>
  );
}
