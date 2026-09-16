import { createHash } from "node:crypto";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import {
  verifyLegacyHistoricalBindingEnvelope,
  type LegacyHistoricalBindingApprovalEvidence,
} from "./legacyHistoricalBindingEnvelope.js";
import { hashLegacyHistoricalBindingEnvelope } from "./legacyHistoricalBindingApprovals.js";
import type { storeHistoricalBindingTransition } from "./legacyHistoricalBindingStorage.js";

export type HistoricalBindingWriteEvidence = LegacyHistoricalBindingApprovalEvidence & {
  write: {
    claimCreatedAt: string;
    claimUpdatedAt: string;
    claimAfterSha256: string;
  };
};
const domain = "vayada:legacy-historical-binding-transition:v1\0";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Full target fingerprint set; only the claim may differ across a transition.
 * Hashing supplied data is NOT a database observation or an eligibility decision. */
export function hashHistoricalBindingTargetState(
  evidence: LegacyHistoricalBindingApprovalEvidence,
  claimSha256: string,
) {
  return hash(
    `${domain}target-state\0` +
      canonicalizeJson({
        owner: {
          target: [...evidence.owner.target].sort((a, b) => a.kind.localeCompare(b.kind)),
          identity: evidence.owner.identity,
        },
        property: evidence.binding.property,
        claim: { ...evidence.binding.bindingExpected.claim, rowStateSha256: claimSha256 },
        connections: [...evidence.binding.bindingExpected.connections].sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
      }),
  );
}

/** Internal PREPARE-only translation, not a command or mutation authority.
 * Signature verification precedes translation; no DB/receipt lookup occurs.
 * Caller must independently lock/verify registry approvals, source, current owner,
 * disposition and exact target evidence, then recheck expiry before storage.
 * Store checks actual complete before/after claim hashes, including timestamps.
 * No callback accepting caller-asserted eligibility, no CLI or public-index wiring.
 */
export function buildHistoricalBindingWriteIntent(
  input: Omit<Parameters<typeof verifyLegacyHistoricalBindingEnvelope>[0], "evidence"> & {
    evidence: HistoricalBindingWriteEvidence;
  },
  executionPrincipal: string, // Trusted runner identity, never a manifest field.
) {
  const evidence = structuredClone(input.evidence);
  const { envelope } = verifyLegacyHistoricalBindingEnvelope({ ...input, evidence });
  const fail = (): never => {
    throw new Error("HISTORICAL_BINDING_WRITE_INTENT_INVALID");
  };
  const write = evidence.write;
  const timestamp = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value.slice(0, 23) + "Z";
  };
  if (
    envelope.purpose !== "prepare" ||
    !write ||
    Object.keys(write).sort().join(",") !== "claimAfterSha256,claimCreatedAt,claimUpdatedAt" ||
    !executionPrincipal.trim() ||
    !timestamp(write.claimCreatedAt) ||
    !timestamp(write.claimUpdatedAt) ||
    write.claimCreatedAt > write.claimUpdatedAt ||
    write.claimUpdatedAt > input.now.toISOString().replace("Z", "000Z") ||
    !/^[0-9a-f]{64}$/.test(write.claimAfterSha256) ||
    write.claimAfterSha256 === evidence.binding.bindingExpected.claim.rowStateSha256 ||
    evidence.targetBeforeSha256 !==
      hashHistoricalBindingTargetState(
        evidence,
        evidence.binding.bindingExpected.claim.rowStateSha256,
      ) ||
    evidence.targetAfterSha256 !==
      hashHistoricalBindingTargetState(evidence, write.claimAfterSha256)
  )
    return fail();
  const binding = evidence.binding.bindingExpected;
  const storageInput: Parameters<typeof storeHistoricalBindingTransition>[1] = {
    claimBeforeSha256: binding.claim.rowStateSha256,
    claimAfterSha256: write.claimAfterSha256,
    updatedAt: write.claimUpdatedAt,
    event: {
      command_id: envelope.commandId,
      contract_version: envelope.contractVersion,
      environment: envelope.environment,
      event_kind: "prepare",
      compensates_command_id: null,
      claim_id: binding.claim.id,
      property_id: binding.propertyId,
      external_property_id: binding.source.externalPropertyId,
      provider: "channex",
      claim_source: "migration",
      claim_created_at: write.claimCreatedAt,
      source_run_id: binding.sourceRunId,
      source_active: true,
      source_evidence_sha256: evidence.binding.sourceRequest.sourceEvidenceSha256,
      payload_sha256: hash(input.canonicalPayload),
      target_before_sha256: evidence.targetBeforeSha256,
      target_after_sha256: evidence.targetAfterSha256,
      approval_envelope_sha256: hashLegacyHistoricalBindingEnvelope(input.canonicalPayload),
      executor_principal_sha256: hash(`${domain}executor\0${executionPrincipal}`),
      before_state: "historical",
      after_state: "verified_non_active",
    },
  };
  return { executable: false as const, storageInput };
}
