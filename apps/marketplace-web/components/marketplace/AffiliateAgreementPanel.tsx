"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircleIcon, ClockIcon } from "@heroicons/react/24/outline";

import {
  changeMarketplaceCollaborationAffiliateLifecycle,
  getMarketplaceCollaborationAffiliateAssent,
  recordMarketplaceCollaborationAffiliateAssent,
  type MarketplaceAffiliateAssentRead,
} from "@vayada/marketplace-shared/api/collaborations";
import { ApiErrorResponse } from "@vayada/marketplace-shared/api/client";

type AgreementState =
  | { kind: "loading"; collaborationId: string }
  | { kind: "ready"; collaborationId: string; agreement: MarketplaceAffiliateAssentRead }
  | { kind: "unavailable"; collaborationId: string }
  | { kind: "error"; collaborationId: string };

type AffiliateAgreementPanelProps = {
  collaborationId: string;
  currentUserType: "creator" | "hotel";
  affiliateExpected: boolean;
  collaborationStatus: string;
};

export function AffiliateAgreementPanel({
  collaborationId,
  currentUserType,
  affiliateExpected,
  collaborationStatus,
}: AffiliateAgreementPanelProps) {
  const [state, setState] = useState<AgreementState>({ kind: "loading", collaborationId });
  const [retry, setRetry] = useState(0);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setState({ kind: "loading", collaborationId });

    getMarketplaceCollaborationAffiliateAssent(collaborationId, {
      signal: controller.signal,
    })
      .then((agreement) => {
        if (current) setState({ kind: "ready", collaborationId, agreement });
      })
      .catch((error: unknown) => {
        if (!current || controller.signal.aborted) return;
        setState({
          kind: error instanceof ApiErrorResponse && error.status === 404 ? "unavailable" : "error",
          collaborationId,
        });
      });

    return () => {
      current = false;
      controller.abort();
    };
  }, [collaborationId, retry]);

  useEffect(() => setCommandNotice(null), [collaborationId]);

  const currentState: AgreementState =
    state.collaborationId === collaborationId ? state : { kind: "loading", collaborationId };

  if (!affiliateExpected && currentState.kind !== "ready") return null;

  return (
    <section
      aria-labelledby="affiliate-agreement-heading"
      className="border-t border-gray-200 pt-6"
    >
      <h5 id="affiliate-agreement-heading" className="font-bold text-gray-900 mb-3">
        Affiliate agreement
      </h5>
      {currentState.kind === "loading" && <AgreementSkeleton />}
      {currentState.kind === "unavailable" && (
        <AgreementUnavailable currentUserType={currentUserType} />
      )}
      {currentState.kind === "error" && (
        <AgreementError onRetry={() => setRetry((value) => value + 1)} />
      )}
      {currentState.kind === "ready" && (
        <AgreementDetails
          agreement={currentState.agreement}
          collaborationId={collaborationId}
          currentUserType={currentUserType}
          collaborationStatus={collaborationStatus}
          onRecorded={(notice) => {
            setCommandNotice(notice);
            setRetry((value) => value + 1);
          }}
        />
      )}
      {commandNotice && (
        <p role="status" className="mt-3 text-sm font-medium text-green-800">
          {commandNotice}
        </p>
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

function AgreementUnavailable({ currentUserType }: { currentUserType: "creator" | "hotel" }) {
  return (
    <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <p className="font-semibold text-amber-950">Affiliate partnership not eligible yet</p>
      <p className="mt-1 text-sm leading-relaxed text-amber-900">
        {currentUserType === "creator"
          ? "Marketplace cannot verify published terms and eligibility. Ask the hotel to review its affiliate offer before trying again."
          : "Marketplace cannot verify published terms and eligibility. Review this offer’s affiliate terms before trying again."}
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
  collaborationId,
  currentUserType,
  collaborationStatus,
  onRecorded,
}: {
  agreement: MarketplaceAffiliateAssentRead;
  collaborationId: string;
  currentUserType: "creator" | "hotel";
  collaborationStatus: string;
  onRecorded: (notice: string) => void;
}) {
  const [action, setAction] = useState<"idle" | "saving" | "error">("idle");
  const [lifecycleAction, setLifecycleAction] = useState<"idle" | "saving" | "error">("idle");
  const idempotencyKey = useRef<{ scope: string; key: string } | null>(null);
  const lifecycleKey = useRef<{ scope: string; key: string } | null>(null);
  const matched = agreement.assentState === "matched";
  const closedBeforeActivation =
    !agreement.lifecycle && ["declined", "cancelled", "rejected"].includes(collaborationStatus);
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
            {closedBeforeActivation
              ? "Affiliate partnership declined"
              : agreement.lifecycle
                ? lifecycleTitle(agreement.lifecycle.status)
                : matched
                  ? "Terms accepted — activation pending"
                  : pendingTitle}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-gray-600">
            {closedBeforeActivation
              ? "This request cannot be activated. Start a new collaboration to propose affiliate terms again."
              : agreement.lifecycle
                ? lifecycleDescription(
                    agreement.lifecycle.status,
                    agreement.lifecycle.pausedBy,
                    currentUserType,
                  )
                : matched
                  ? "Both sides accepted the same retained terms. Marketplace is still checking activation and earning eligibility."
                  : otherSideComplete
                    ? "The other side has recorded its decision. This agreement is not active from assent alone."
                    : "Review the retained terms below. Recording this decision does not activate links or earnings."}
          </p>
        </div>
      </div>

      <Disclosure disclosure={agreement.terms.disclosure} />

      {!currentSideComplete && !closedBeforeActivation && (
        <button
          type="button"
          disabled={action === "saving"}
          onClick={async () => {
            if (idempotencyKey.current?.scope !== collaborationId)
              idempotencyKey.current = { scope: collaborationId, key: crypto.randomUUID() };
            setAction("saving");
            try {
              const result = await recordMarketplaceCollaborationAffiliateAssent(
                collaborationId,
                idempotencyKey.current.key,
              );
              onRecorded(
                result.replayed
                  ? "Your decision was already recorded."
                  : "Your decision was recorded.",
              );
            } catch {
              setAction("error");
            }
          }}
          className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {action === "saving"
            ? "Recording…"
            : currentUserType === "creator"
              ? "Accept affiliate terms"
              : "Approve affiliate agreement"}
        </button>
      )}

      {action === "error" && (
        <div role="alert" className="text-sm text-red-800">
          <p>Could not record your decision. Try again.</p>
          <button
            type="button"
            onClick={() => setAction("idle")}
            className="mt-2 font-semibold underline focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
          >
            Try again
          </button>
        </div>
      )}

      {agreement.lifecycle && agreement.lifecycle.status !== "ended" && (
        <div className="flex flex-wrap gap-2 border-t border-gray-200 pt-4">
          {agreement.lifecycle.status === "active" ||
          !agreement.lifecycle.pausedBy.includes(currentUserType) ? (
            <LifecycleButton
              label="Pause affiliate agreement"
              disabled={lifecycleAction === "saving"}
              onClick={() => runLifecycle("pause")}
            />
          ) : (
            <LifecycleButton
              label="Resume affiliate agreement"
              disabled={lifecycleAction === "saving"}
              onClick={() => runLifecycle("resume")}
            />
          )}
          <LifecycleButton
            label="End affiliate agreement"
            disabled={lifecycleAction === "saving"}
            onClick={() => runLifecycle("end")}
          />
        </div>
      )}

      {lifecycleAction === "error" && (
        <p role="alert" className="text-sm text-red-800">
          Could not update the affiliate agreement. Refresh and try again.
        </p>
      )}

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

  async function runLifecycle(nextAction: "pause" | "resume" | "end") {
    if (nextAction === "end" && !window.confirm("End this affiliate agreement permanently?"))
      return;
    const scope = `${collaborationId}:${nextAction}:${agreement.lifecycle?.revision}`;
    if (lifecycleKey.current?.scope !== scope)
      lifecycleKey.current = { scope, key: crypto.randomUUID() };
    setLifecycleAction("saving");
    try {
      const result = await changeMarketplaceCollaborationAffiliateLifecycle(
        collaborationId,
        {
          action: nextAction,
          reason: {
            pause: "Paused in Marketplace",
            resume: "Resumed in Marketplace",
            end: "Ended in Marketplace",
          }[nextAction],
          expectedRevision: agreement.lifecycle!.revision,
        },
        lifecycleKey.current.key,
      );
      setLifecycleAction("idle");
      onRecorded(
        result.replayed ? "That update was already recorded." : "Affiliate agreement updated.",
      );
    } catch {
      setLifecycleAction("error");
    }
  }
}

function LifecycleButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {label}
    </button>
  );
}

function lifecycleTitle(status: "active" | "paused" | "ended") {
  return status === "active"
    ? "Affiliate agreement active"
    : status === "paused"
      ? "Affiliate agreement paused"
      : "Affiliate agreement ended";
}

function lifecycleDescription(
  status: "active" | "paused" | "ended",
  pausedBy: ("hotel" | "creator")[],
  currentUserType: "creator" | "hotel",
) {
  if (status === "active")
    return "The agreement remains active independently of the hosted collaboration.";
  if (status === "ended")
    return "No new referrals can qualify. Existing attribution and earnings history remain available.";
  const yours = pausedBy.includes(currentUserType);
  const other = pausedBy.includes(currentUserType === "creator" ? "hotel" : "creator");
  return yours && other
    ? "Both sides paused this agreement. Each side must resume before new referrals can qualify."
    : yours
      ? "You paused this agreement. Resume it when new referrals should qualify again."
      : "The other side paused this agreement. Existing attribution and earnings are preserved.";
}

function Disclosure({ disclosure }: { disclosure: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Retained terms</p>
      <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm font-medium text-gray-900">
        {disclosure}
      </pre>
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

function formatDecisionDate(timestamp: string): string {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}
