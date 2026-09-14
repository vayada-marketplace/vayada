/** Offline diagnostic only: no SQL, provider calls, credentials, or executable writes. */
export type OwnerBootstrapObservation = {
  ownerId: string;
  sourceStatus: string;
  sourceOwnership: "matched" | "missing" | "conflict";
  target: "absent" | "exact" | "conflict" | "restricted" | "unknown";
  providerExternalId: "absent" | "exact" | "conflict" | "unknown";
  providerEmail: "absent" | "same_identity" | "conflict" | "unknown";
};

export type OwnerBootstrapEvidence = {
  sourceRunId: string;
  targetEnvironment: "preprod" | "production";
  observedAt: string;
  expiresAt: string;
  complete: boolean;
  owners: OwnerBootstrapObservation[];
};

type NextStep =
  "prepare_missing_identity" | "prepare_provider_identity" | "verify_existing_identity";
type OwnerResult = {
  ownerId: string;
  outcome: "blocked" | "proposed";
  reason: string;
  nextStep?: NextStep;
};

/**
 * Trusted operator supplies an independently approved eight-ID cohort and the
 * expected run/environment, never derives them from the observed rows. Evidence
 * is a sanitized reader summary, NOT cryptographically verified by this helper.
 * A proposal is only a work item; it cannot authorize provisioning or PMS access.
 */
export function planLegacyOwnerBootstrap(
  expected: { ownerIds: readonly string[]; sourceRunId: string; targetEnvironment: string },
  evidence: OwnerBootstrapEvidence,
  now: Date,
) {
  const blocked = (reason: string) => ({
    outcome: "blocked" as const,
    reason,
    owners: [] as OwnerResult[],
    executable: false as const,
  });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (
    !Array.isArray(expected.ownerIds) ||
    expected.ownerIds.length !== 8 ||
    !expected.ownerIds.every((id) => typeof id === "string" && uuid.test(id)) ||
    new Set(expected.ownerIds).size !== 8
  )
    return blocked("invalid_cohort");
  if (
    !/^vay1351-[0-9a-f]{24}$/.test(expected.sourceRunId) ||
    !["preprod", "production"].includes(expected.targetEnvironment) ||
    evidence.sourceRunId !== expected.sourceRunId ||
    evidence.targetEnvironment !== expected.targetEnvironment
  )
    return blocked("environment_or_run_mismatch");
  const observed = timestamp(evidence.observedAt),
    expiry = timestamp(evidence.expiresAt);
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(observed) ||
    !Number.isFinite(expiry) ||
    observed > now.getTime() ||
    expiry <= now.getTime() ||
    expiry <= observed ||
    expiry - observed > 15 * 60 * 1000
  )
    return blocked("stale_or_invalid_evidence");
  if (
    evidence.complete !== true ||
    !Array.isArray(evidence.owners) ||
    evidence.owners.length !== 8 ||
    new Set(evidence.owners.map((row) => row?.ownerId)).size !== 8 ||
    !evidence.owners.every((row) => row && expected.ownerIds.includes(row.ownerId))
  )
    return blocked("incomplete_cohort");
  const owners = [...evidence.owners]
    .sort((a, b) => a.ownerId.localeCompare(b.ownerId))
    .map(evaluate);
  return {
    outcome: owners.some((row) => row.outcome === "blocked")
      ? ("blocked" as const)
      : ("proposed" as const),
    reason: "diagnostic_only_requires_fresh_verified_evidence",
    owners,
    executable: false as const,
  };
}

function timestamp(value: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
}

function evaluate(row: OwnerBootstrapObservation): OwnerResult {
  const blocked = (reason: string): OwnerResult => ({
    ownerId: row.ownerId,
    outcome: "blocked",
    reason,
  });
  if (!["pending", "active", "accepted", "verified"].includes(row.sourceStatus))
    return blocked("source_restricted_or_unknown");
  if (row.sourceOwnership !== "matched") return blocked("source_ownership_unproven");
  if (!["absent", "exact"].includes(row.target))
    return blocked("target_conflict_restriction_or_unknown");
  if (!["absent", "exact"].includes(row.providerExternalId))
    return blocked("provider_identity_conflict_or_unknown");
  if (!["absent", "same_identity"].includes(row.providerEmail))
    return blocked("email_candidate_conflict_or_unknown");
  if (
    (row.providerExternalId === "absent" && row.providerEmail !== "absent") ||
    (row.providerExternalId === "exact" && row.target === "absent")
  )
    return blocked("identity_reconciliation_required");
  const nextStep: NextStep =
    row.target === "absent"
      ? "prepare_missing_identity"
      : row.providerExternalId === "absent"
        ? "prepare_provider_identity"
        : "verify_existing_identity";
  return {
    ownerId: row.ownerId,
    outcome: "proposed",
    reason: "no_access_or_creation_authorized",
    nextStep,
  };
}
