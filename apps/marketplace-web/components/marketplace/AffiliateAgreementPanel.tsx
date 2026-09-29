"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircleIcon, ClockIcon } from "@heroicons/react/24/outline";
import { buildMarketplaceAffiliateSharePath } from "@vayada/domain-marketplace";

import {
  changeMarketplaceCollaborationAffiliateLifecycle,
  createMarketplaceCollaborationAffiliateLink,
  diagnoseMarketplaceCollaborationAffiliateLink,
  getMarketplaceCollaborationAffiliateAssent,
  recordMarketplaceCollaborationAffiliateAssent,
  type MarketplaceAffiliateAssentRead,
  type MarketplaceAffiliateLinkDiagnosticResponse,
} from "@vayada/marketplace-shared/api/collaborations";
import { ApiErrorResponse, VAYADA_API_BASE_URL } from "@vayada/marketplace-shared/api/client";

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
          key={collaborationId}
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
  const [linkAction, setLinkAction] = useState<"idle" | "saving" | "error">("idle");
  const [affiliateLink, setAffiliateLink] = useState<{ publicToken: string; url: string } | null>(
    null,
  );
  const [linkError, setLinkError] = useState<string | null>(null);
  const [campaignLabel, setCampaignLabel] = useState("");
  const [selectedCampaignLabel, setSelectedCampaignLabel] = useState<string | null>(null);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<
    MarketplaceAffiliateLinkDiagnosticResponse | "loading" | "error" | null
  >(null);
  const idempotencyKey = useRef<{ scope: string; key: string } | null>(null);
  const lifecycleKey = useRef<{ scope: string; key: string } | null>(null);
  const linkKey = useRef<{ scope: string; key: string } | null>(null);
  const diagnosticRequest = useRef(0);
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

      {agreement.lifecycle && (
        <div className="space-y-3">
          {currentUserType === "creator" && (
            <div className="rounded-lg border border-gray-200 bg-white p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Your stable affiliate link
              </p>
              {affiliateLink ? (
                <div className="mt-2 space-y-3">
                  <p
                    aria-label="Stable affiliate link"
                    className="block break-all text-sm font-semibold text-primary-700"
                  >
                    {affiliateLink.url}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={copyLink} className={secondaryButtonClass}>
                      Copy link
                    </button>
                    <button type="button" onClick={shareLink} className={secondaryButtonClass}>
                      Share link
                    </button>
                    <button
                      type="button"
                      disabled={diagnostic === "loading"}
                      onClick={runLinkDiagnostic}
                      className={secondaryButtonClass}
                    >
                      {diagnostic === "loading" ? "Checking…" : "Preview & test"}
                    </button>
                  </div>
                  {shareNotice && (
                    <p
                      role={shareNotice.startsWith("Could not") ? "alert" : "status"}
                      className="text-sm text-gray-700"
                    >
                      {shareNotice}
                    </p>
                  )}
                  <div>
                    <label
                      htmlFor={`affiliate-campaign-${collaborationId}`}
                      className="text-sm font-medium text-gray-800"
                    >
                      Optional campaign label
                    </label>
                    <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                      <input
                        id={`affiliate-campaign-${collaborationId}`}
                        value={campaignLabel}
                        onChange={(event) => setCampaignLabel(event.target.value)}
                        placeholder="instagram.reel-1"
                        className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                      />
                      <button
                        type="button"
                        onClick={applyCampaignLabel}
                        className={secondaryButtonClass}
                      >
                        Use labeled variant
                      </button>
                    </div>
                  </div>
                  {diagnostic && diagnostic !== "loading" && diagnostic !== "error" && (
                    <AffiliateLinkDiagnostic result={diagnostic} />
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  disabled={linkAction === "saving"}
                  onClick={runLinkCommand}
                  className="mt-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {linkAction === "saving" ? "Getting link…" : "Get affiliate link"}
                </button>
              )}
              {linkAction === "error" && (
                <p role="alert" className="mt-2 text-sm text-red-800">
                  {linkError}
                </p>
              )}
            </div>
          )}
          <a
            href={`/earnings?propertyId=${encodeURIComponent(agreement.propertyId)}`}
            className="inline-block text-sm font-semibold text-primary-700 underline"
          >
            View results & earnings
          </a>
        </div>
      )}

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

  async function runLinkCommand() {
    if (linkKey.current?.scope !== collaborationId)
      linkKey.current = { scope: collaborationId, key: crypto.randomUUID() };
    setLinkAction("saving");
    setLinkError(null);
    try {
      const result = await createMarketplaceCollaborationAffiliateLink(
        collaborationId,
        linkKey.current.key,
      );
      setAffiliateLink({
        publicToken: result.publicToken,
        url: new URL(result.path, VAYADA_API_BASE_URL).toString(),
      });
      setLinkAction("idle");
    } catch (error) {
      setLinkError(affiliateLinkErrorMessage(error, agreement.lifecycle?.status));
      setLinkAction("error");
    }
  }

  function applyCampaignLabel() {
    if (!affiliateLink) return;
    const share = buildMarketplaceAffiliateSharePath(
      affiliateLink.publicToken,
      campaignLabel.trim() || undefined,
    );
    if (!share.ok) {
      setShareNotice(
        "Could not use that label. Use 1–64 letters, numbers, dots, dashes or underscores.",
      );
      return;
    }
    setAffiliateLink({
      publicToken: affiliateLink.publicToken,
      url: new URL(share.path, VAYADA_API_BASE_URL).toString(),
    });
    setSelectedCampaignLabel(share.campaignLabel);
    setShareNotice(share.campaignLabel ? "Labeled variant selected." : "Default link selected.");
    diagnosticRequest.current += 1;
    setDiagnostic(null);
  }

  async function copyLink() {
    if (!affiliateLink) return;
    try {
      await navigator.clipboard.writeText(affiliateLink.url);
      setShareNotice("Link copied.");
    } catch {
      setShareNotice("Could not copy the link. Select the URL and copy it manually.");
    }
  }

  async function shareLink() {
    if (!affiliateLink) return;
    if (!navigator.share) {
      setShareNotice("Could not share from this browser. Copy the link instead.");
      return;
    }
    try {
      await navigator.share({ title: "Book this hotel", url: affiliateLink.url });
      setShareNotice("Share sheet opened.");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        setShareNotice("Could not share the link. Copy it instead.");
    }
  }

  async function runLinkDiagnostic() {
    const request = ++diagnosticRequest.current;
    setDiagnostic("loading");
    try {
      const result = await diagnoseMarketplaceCollaborationAffiliateLink(
        collaborationId,
        selectedCampaignLabel,
      );
      if (request === diagnosticRequest.current) setDiagnostic(result);
    } catch (error) {
      if (request === diagnosticRequest.current) {
        setDiagnostic("error");
        setShareNotice(affiliateDiagnosticErrorMessage(error));
      }
    }
  }
}

const secondaryButtonClass =
  "rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60";

function AffiliateLinkDiagnostic({
  result,
}: {
  result: MarketplaceAffiliateLinkDiagnosticResponse;
}) {
  const title =
    result.status === "ready"
      ? "Link ready to share"
      : result.status === "program_inactive"
        ? `Affiliate program ${result.programStatus}`
        : result.status === "link_invalid"
          ? "Affiliate link invalid"
          : "Booking destination unavailable";
  return (
    <div
      role="status"
      className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700"
    >
      <p className="font-semibold text-gray-900">{title}</p>
      <p>Creator and hotel association verified.</p>
      {result.status === "program_inactive" && (
        <p>Resume the paused agreement, or start a new agreement if it ended.</p>
      )}
      {result.status === "link_invalid" && (
        <p>Retrieve the affiliate link again. Contact support if it remains invalid.</p>
      )}
      {result.status === "destination_unavailable" && (
        <p>Ask the hotel to fix its booking destination, then test the link again.</p>
      )}
      {result.destinationUrl && <p className="break-all">Destination: {result.destinationUrl}</p>}
      <p>
        Read-only diagnostic: no visit was recorded or added to normal metrics. This checks link
        health only; no booking or purchase was verified.
      </p>
    </div>
  );
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

function affiliateLinkErrorMessage(
  error: unknown,
  status: "active" | "paused" | "ended" | undefined,
) {
  if (error instanceof ApiErrorResponse && error.data.code === "link_creation_blocked")
    return "The link is not ready. Ask the hotel to check its booking destination, then try again.";
  if (error instanceof ApiErrorResponse && error.data.code === "agreement_not_active") {
    if (status === "ended")
      return "This agreement ended before a link was available. Start a new approved agreement to earn from new referrals.";
    if (status === "paused") return "Resume the agreement, then try again.";
    return "The agreement status changed. Refresh the collaboration details, then try again.";
  }
  return "Could not retrieve the affiliate link. Try again.";
}

function affiliateDiagnosticErrorMessage(error: unknown) {
  if (error instanceof ApiErrorResponse && error.data.code === "invalid_request")
    return "Could not test that label. Use 1–64 letters, numbers, dots, dashes or underscores.";
  if (error instanceof ApiErrorResponse && error.data.code === "link_unavailable")
    return "The affiliate link is no longer available. Retrieve it again, then retry.";
  return "Could not verify the link configuration. Ask the hotel to check its booking destination, then retry.";
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
