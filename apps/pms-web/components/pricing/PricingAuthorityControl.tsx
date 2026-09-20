"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiErrorResponse } from "@/services/api/client";
import type {
  PricingAuthority,
  createReplacementPricingClient,
} from "@/services/api/replacementPricingClient";

type Client = ReturnType<typeof createReplacementPricingClient>;
const labels = {
  unconfigured: "No direct-booking price source selected",
  vayada: "Vayada prices",
  external: "External PMS prices",
} as const;

/** This choice is explicit and separate from publishing rates or connecting channels. */
export function PricingAuthorityControl({
  client,
  blocked,
  onActivityChange,
}: {
  client: Client;
  blocked: boolean;
  onActivityChange(active: boolean): void;
}) {
  const [current, setCurrent] = useState<PricingAuthority | null>(null);
  const [choice, setChoice] = useState<PricingAuthority["authority"]>("unconfigured");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [pending, setPending] = useState<ReturnType<Client["authorityAction"]> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    onActivityChange(busy || !!pending);
  }, [busy, pending, onActivityChange]);
  const reload = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const value = await client.readAuthority();
      if (alive.current) {
        setCurrent(value);
        setChoice(value.authority);
      }
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "Could not load the price source.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [client]);
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);
  async function save() {
    if (!current || busy || blocked) return;
    let action = pending;
    if (!action) {
      if (
        !window.confirm(
          `Use ${labels[choice]} for this property's direct-booking prices? Existing quotes will need a fresh price.`,
        )
      )
        return;
      action = client.authorityAction(current.revision, choice);
      setPending(() => action);
    }
    setBusy(true);
    setError("");
    try {
      const result = await action();
      setPending(null);
      const saved = await client.readAuthority();
      if (saved.revision !== result.revision || saved.authority !== choice)
        throw new Error("Price source could not be verified. Reload it before continuing.");
      if (alive.current) setCurrent(saved);
    } catch (e) {
      if (e instanceof ApiErrorResponse && [400, 403, 409].includes(e.status)) setPending(null);
      if (alive.current)
        setError(
          e instanceof ApiErrorResponse && e.status === 409
            ? "The price source changed. Reload before choosing again."
            : e instanceof Error
              ? e.message
              : "Could not save the price source. Retry the same action.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="rounded-xl border bg-white p-5" aria-label="Direct-booking price source">
      <h2 className="font-semibold">Direct-booking price source</h2>
      <p className="mt-1 text-sm text-gray-600">
        Choose who owns prices shown to guests. Publishing rates alone does not make them bookable.
        External PMS pricing remains unavailable until its connection is supported.
      </p>
      {current && (
        <p className="mt-3 text-sm">
          Current: <strong>{labels[current.authority]}</strong>
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <select
          aria-label="Price source"
          className="rounded border px-3 py-2 text-sm"
          disabled={!current || busy || blocked || !!pending}
          value={choice}
          onChange={(e) => setChoice(e.target.value as PricingAuthority["authority"])}
        >
          <option value="unconfigured">No source selected</option>
          <option value="vayada">Vayada prices</option>
          <option value="external">External PMS prices</option>
        </select>
        <button
          type="button"
          className="rounded border px-4 py-2 text-sm disabled:opacity-50"
          disabled={!current || busy || blocked}
          onClick={() => void save()}
        >
          {pending
            ? "Retry same change"
            : choice === current?.authority
              ? "Reaffirm price source"
              : "Save price source"}
        </button>
        <button
          type="button"
          className="rounded border px-4 py-2 text-sm disabled:opacity-50"
          disabled={busy || !!pending}
          onClick={() => void reload()}
        >
          Reload source
        </button>
      </div>
    </section>
  );
}
