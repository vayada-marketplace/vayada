"use client";

import { useEffect, useState } from "react";
import { CheckCircleIcon, ClockIcon } from "@heroicons/react/24/outline";

import {
  getMarketplaceCollaborationAffiliateAssent,
  type MarketplaceAffiliateAssentRead,
} from "@vayada/marketplace-shared/api/collaborations";
import { ApiErrorResponse } from "@vayada/marketplace-shared/api/client";

type AgreementState =
  | { kind: "loading" }
  | { kind: "ready"; agreement: MarketplaceAffiliateAssentRead }
  | { kind: "unavailable" }
  | { kind: "error" };

type AffiliateAgreementPanelProps = {
  collaborationId: string;
  currentUserType: "creator" | "hotel";
  affiliateExpected: boolean;
};

export function AffiliateAgreementPanel({
  collaborationId,
  currentUserType,
  affiliateExpected,
}: AffiliateAgreementPanelProps) {
  const [state, setState] = useState<AgreementState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setState({ kind: "loading" });

    getMarketplaceCollaborationAffiliateAssent(collaborationId, {
      signal: controller.signal,
    })
      .then((agreement) => {
        if (current) setState({ kind: "ready", agreement });
      })
      .catch((error: unknown) => {
        if (!current || controller.signal.aborted) return;
        setState({
          kind: error instanceof ApiErrorResponse && error.status === 404 ? "unavailable" : "error",
        });
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [collaborationId, retry]);

  if (!affiliateExpected && state.kind !== "ready") return null;

  return (
    <section
      aria-labelledby="affiliate-agreement-heading"
      className="border-t border-gray-200 pt-6"
    >
      <h5 id="affiliate-agreement-heading" className="font-bold text-gray-900 mb-3">
        Affiliate agreement
      </h5>
      {state.kind === "loading" && <AgreementSkeleton />}
      {state.kind === "unavailable" && <AgreementUnavailable />}
      {state.kind === "error" && <AgreementError onRetry={() => setRetry((value) => value + 1)} />}
      {state.kind === "ready" && (
        <AgreementDetails agreement={state.agreement} currentUserType={currentUserType} />
      )}
    </section>
  );
}

function AgreementSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading affiliate agreement"
      className="rounded-xl border border-gray-200 p-4 space-y-3"
    >
      <div className="h-4 w-40 rounded bg-gray-200 animate-pulse" />
      <div className="h-3 w-full rounded bg-gray-100 animate-pulse" />
      <div className="h-3 w-2/3 rounded bg-gray-100 animate-pulse" />
    </div>
  );
}

function AgreementUnavailable() {
  return (
    <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <p className="font-semibold text-amber-950">Affiliate agreement unavailable</p>
      <p className="mt-1 text-sm leading-relaxed text-amber-900">
        This collaboration advertises affiliate terms, but this screen cannot verify a retained
        agreement or earning eligibility.
      </p>
    </div>
  );
}

function AgreementError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4">
      <p className="font-semibold text-red-950">Could not load affiliate agreement</p>
      <p className="mt-1 text-sm leading-relaxed text-red-900">
        Try again before relying on the displayed collaboration terms.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-semibold text-red-800 hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
      >
        Try again
      </button>
    </div>
  );
}

function AgreementDetails({
  agreement,
  currentUserType,
}: {
  agreement: MarketplaceAffiliateAssentRead;
  currentUserType: "creator" | "hotel";
}) {
  const matched = agreement.assentState === "matched";
  const currentSideComplete =
    currentUserType === "creator" ? agreement.creatorAcceptedAt : agreement.hotelApprovedAt;
  const otherSideComplete =
    currentUserType === "creator" ? agreement.hotelApprovedAt : agreement.creatorAcceptedAt;
  const pendingTitle = currentSideComplete
    ? `Waiting for ${currentUserType === "creator" ? "hotel approval" : "creator acceptance"}`
    : currentUserType === "creator"
      ? "Your acceptance is pending"
      : "Your approval is pending";

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-5">
      <div className="flex items-start gap-3">
        {matched ? (
          <CheckCircleIcon className="mt-0.5 h-5 w-5 flex-none text-green-700" aria-hidden="true" />
        ) : (
          <ClockIcon className="mt-0.5 h-5 w-5 flex-none text-amber-700" aria-hidden="true" />
        )}
        <div>
          <p className="font-semibold text-gray-900">
            {matched ? "Agreement accepted" : pendingTitle}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-gray-600">
            {matched
              ? "Both sides accepted the same retained terms. Link activation and earning eligibility are checked separately."
              : otherSideComplete
                ? "The other side has recorded its decision. This agreement is not active from assent alone."
                : "Review the retained terms below. This screen does not record approval or acceptance."}
          </p>
        </div>
      </div>

      <Disclosure disclosure={agreement.terms.disclosure} />

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Decision
          label="Hotel approval"
          timestamp={agreement.hotelApprovedAt}
          completeLabel="Approved"
        />
        <Decision
          label="Creator acceptance"
          timestamp={agreement.creatorAcceptedAt}
          completeLabel="Accepted"
        />
      </dl>
    </div>
  );
}

function Disclosure({ disclosure }: { disclosure: string }) {
  const entries = disclosureEntries(disclosure);
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Retained terms</p>
      {entries?.length ? (
        <dl className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {entries.map(([label, value], index) => (
            <div key={`${label}-${index}`} className="min-w-0">
              <dt className="text-xs text-gray-500">{label}</dt>
              <dd className="mt-0.5 break-words text-sm font-semibold text-gray-900">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-gray-800">{disclosure}</p>
      )}
    </div>
  );
}

function Decision({
  label,
  timestamp,
  completeLabel,
}: {
  label: string;
  timestamp: string | null;
  completeLabel: string;
}) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-gray-900">
        {timestamp ? `${completeLabel} ${formatDecisionDate(timestamp)}` : "Not recorded"}
      </dd>
    </div>
  );
}

export function disclosureEntries(disclosure: string): Array<[string, string]> | null {
  try {
    const parsed: unknown = JSON.parse(disclosure);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.entries(parsed).map(([key, value]) => [readableKey(key), displayValue(value)]);
  } catch {
    return null;
  }
}

function readableKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function displayValue(value: unknown): string {
  if (value === null) return "None";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function formatDecisionDate(timestamp: string): string {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}
