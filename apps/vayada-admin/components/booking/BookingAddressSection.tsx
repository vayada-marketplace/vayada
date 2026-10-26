"use client";

import { useState } from "react";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import {
  propertySlugErrorMessage,
  propertySlugService,
  type PropertySlugChangePreview,
  type PropertySlugChangeResult,
} from "@/services/api/propertySlug";

/** Moves a hotel's booking page to a new address (VAY-2295). Preview first: the change sends the
 * previewed plan, and the server refuses it if anything moved since. The former address keeps
 * forwarding guests, so open booking tabs keep working. */
export default function BookingAddressSection({
  hotelId,
  currentSlug,
}: {
  hotelId: string;
  currentSlug: string | undefined;
}) {
  const [slug, setSlug] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<PropertySlugChangePreview | null>(null);
  const [result, setResult] = useState<PropertySlugChangeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(propertySlugErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const showPreview = () =>
    run(async () => {
      setResult(null);
      setPreview(await propertySlugService.preview(hotelId, slug.trim()));
    });
  const change = () =>
    run(async () => {
      setResult(await propertySlugService.change(hotelId, preview!, reason.trim()));
      setPreview(null);
      setSlug("");
      setReason("");
    });

  const plan = preview?.plan;
  const publication = result?.publication;
  // The address the page still carried before the change (a rerun's plan names the new one twice).
  const former = result?.plan.livePage?.pageSlug ?? result?.plan.fromSlug;
  return (
    <section
      aria-label="Booking page address"
      className="max-w-3xl rounded-lg border border-gray-200 bg-white p-5"
    >
      <h2 className="text-base font-semibold text-gray-900">Booking page address</h2>
      <p className="mt-1 text-sm text-gray-600">
        Guests reach this hotel&apos;s booking page at{" "}
        <span className="font-medium text-gray-900">{result?.plan.toSlug ?? currentSlug}</span>. A
        new address takes over at once; the old one forwards guests to it.
      </p>

      {!plan && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-gray-700">
            New address
            <input
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              placeholder="hotel-name"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm text-gray-700">
            Reason
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why the address changes"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="button"
              onClick={showPreview}
              disabled={busy || !slug.trim() || !reason.trim()}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
            >
              Preview the change
            </button>
          </div>
        </div>
      )}

      {plan && (
        <div className="mt-4 rounded-lg border border-gray-200 p-4 text-sm text-gray-700">
          <p className="font-medium text-gray-900">
            {plan.change === "already_applied"
              ? `${plan.toSlug} is already this hotel's address.`
              : `From ${plan.fromSlug} to ${plan.toSlug}`}
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {plan.change === "former_address" && (
              <li>This was one of the hotel&apos;s former addresses; it becomes current again.</li>
            )}
            {plan.livePage && plan.livePage.pageSlug !== plan.toSlug ? (
              <li>
                The live booking page is republished at the new address. Open booking tabs on the
                old address keep working.
              </li>
            ) : plan.livePage ? (
              <li>The live booking page already shows this address. Nothing changes.</li>
            ) : (
              <li>The hotel has no live booking page. Only the address changes.</li>
            )}
          </ul>
          <p className="mt-2 text-xs text-gray-500">Plan {preview.planSha256.slice(0, 12)}</p>
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={change}
              disabled={busy}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
            >
              Change address
            </button>
            <button
              type="button"
              onClick={() => setPreview(null)}
              disabled={busy}
              className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {result && publication?.status !== "failed" && (
        <p role="status" className="mt-4 text-sm text-emerald-700">
          {publication?.status === "not_live"
            ? `The address is now ${result.plan.toSlug}. The hotel has no live booking page yet.`
            : publication?.status === "current"
              ? `The booking page is already at ${result.plan.toSlug}.`
              : `The booking page is now at ${result.plan.toSlug}. ${former} forwards guests to it.`}
        </p>
      )}
      {publication?.status === "failed" && (
        <div
          role="status"
          className="mt-4 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
        >
          <ExclamationTriangleIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
          <p>
            The address changed to {result!.plan.toSlug}, but the page couldn&apos;t be republished
            ({publication.code}). It keeps working at {former}. Change the address to{" "}
            {result!.plan.toSlug} again to retry.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
