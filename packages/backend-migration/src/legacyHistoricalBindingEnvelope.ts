import { createHash, verify, type KeyObject } from "node:crypto";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import type { LegacyOwnerEvidenceRequest } from "./legacyOwnerEvidenceSnapshot.js";
import type { LegacyOwnerApprovalEnvelope } from "./legacyOwnerApprovalEnvelope.js";
import type { LegacyHistoricalBindingEvidenceRequest } from "./legacyHistoricalBindingEvidenceSnapshot.js";
import { evaluateLegacyHistoricalBinding } from "./legacyHistoricalBindingPreflight.js";
import { compareLegacyOwnershipBeforeState } from "./legacyOwnershipBeforeState.js";

const DOMAIN = "vayada:legacy-historical-binding-transition:v1\0";
export const LEGACY_HISTORICAL_BINDING_VERSION = "legacy-historical-binding-transition.v1";
export type LegacyHistoricalBindingApprovalEvidence = {
  owner: LegacyOwnerEvidenceRequest;
  binding: LegacyHistoricalBindingEvidenceRequest;
  sourceActive: true;
  targetBeforeSha256: string;
  targetAfterSha256: string;
};
export type LegacyHistoricalBindingEnvelope = Omit<
  LegacyOwnerApprovalEnvelope,
  "contractVersion"
> & {
  contractVersion: typeof LEGACY_HISTORICAL_BINDING_VERSION;
  purpose: "prepare" | "compensate";
  originalPrepareCommandId: string | null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const fields = [
  "contractVersion",
  "commandId",
  "environment",
  "purpose",
  "originalPrepareCommandId",
  "issuedAt",
  "expiresAt",
  "evidenceSha256",
  "migrationApprovalRecordId",
  "securityApprovalRecordId",
  "signingKeyId",
];
export const hashLegacyHistoricalBindingApprovalEvidence = (
  evidence: LegacyHistoricalBindingApprovalEvidence,
) =>
  createHash("sha256")
    .update(`${DOMAIN}evidence\0`)
    .update(canonicalizeJson(evidence))
    .digest("hex");

/** Signature only. Trusted keys/environment/clock; registry, locked eligibility and execution remain mandatory. */
export function verifyLegacyHistoricalBindingEnvelope(input: {
  canonicalPayload: string;
  detachedSignature: string;
  verificationKeys: ReadonlyMap<string, KeyObject>;
  environment: LegacyHistoricalBindingEnvelope["environment"];
  evidence: LegacyHistoricalBindingApprovalEvidence;
  now: Date;
}) {
  const fail = (reason: string): never => {
    throw new Error(`Historical binding approval: ${reason}`);
  };
  let value: unknown;
  try {
    value = JSON.parse(input.canonicalPayload);
  } catch {
    return fail("invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid_envelope");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join("\0") !== [...fields].sort().join("\0") ||
    fields.some((key) => key !== "originalPrepareCommandId" && typeof row[key] !== "string")
  )
    return fail("invalid_fields");
  if (canonicalizeJson(row) !== input.canonicalPayload) return fail("noncanonical_payload");
  const envelope = row as LegacyHistoricalBindingEnvelope;
  if (envelope.contractVersion !== LEGACY_HISTORICAL_BINDING_VERSION) return fail("wrong_contract");
  if (
    !["local", "staging", "preprod", "production"].includes(envelope.environment) ||
    envelope.environment !== input.environment
  )
    return fail("wrong_environment");
  if (
    ![
      envelope.commandId,
      envelope.migrationApprovalRecordId,
      envelope.securityApprovalRecordId,
    ].every((id) => UUID.test(id)) ||
    envelope.migrationApprovalRecordId === envelope.securityApprovalRecordId
  )
    return fail("invalid_authority_records");
  if (
    !(
      (envelope.purpose === "prepare" && envelope.originalPrepareCommandId === null) ||
      (envelope.purpose === "compensate" &&
        typeof envelope.originalPrepareCommandId === "string" &&
        UUID.test(envelope.originalPrepareCommandId) &&
        envelope.originalPrepareCommandId !== envelope.commandId)
    )
  )
    return fail("invalid_purpose");
  const timestamp = (value: string) => {
    const date = new Date(value);
    return (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(date.getTime()) &&
      date.toISOString() === value
    );
  };
  if (
    !timestamp(envelope.issuedAt) ||
    !timestamp(envelope.expiresAt) ||
    !Number.isFinite(input.now.getTime()) ||
    envelope.issuedAt >= envelope.expiresAt ||
    envelope.issuedAt > input.now.toISOString() ||
    envelope.expiresAt <= input.now.toISOString()
  )
    return fail("invalid_time_window");
  if (
    !SHA.test(envelope.evidenceSha256) ||
    envelope.evidenceSha256 !== hashLegacyHistoricalBindingApprovalEvidence(input.evidence)
  )
    return fail("evidence_mismatch");
  const { owner, binding } = input.evidence;
  const { sourceRequest, bindingExpected, property } = binding;
  const validation = evaluateLegacyHistoricalBinding(bindingExpected, {
    sourceRunId: "",
    sourceConnections: [],
    claims: [],
    connections: [],
  });
  if (
    validation.outcome === "blocked" &&
    ["invalid_expected", "protected_fixture"].includes(validation.reason)
  )
    return fail(validation.reason);
  if (input.evidence.sourceActive !== true) return fail("source_inactive");
  if (compareLegacyOwnershipBeforeState(owner.target, owner.target).outcome !== "unchanged")
    return fail("invalid_owner_expected");
  const target = (kind: string) => owner.target.find((r) => r.kind === kind)!;
  if (
    ![input.evidence.targetBeforeSha256, input.evidence.targetAfterSha256].every((hash) =>
      SHA.test(hash),
    ) ||
    owner.source.ownerUserId !== target("user").id ||
    owner.identity.userId !== target("user").id ||
    owner.identity.organizationId !== target("organization").id ||
    owner.source.legacyHotelId !== bindingExpected.source.hotelId ||
    target("property").id !== bindingExpected.propertyId ||
    property.id !== bindingExpected.propertyId ||
    property.rowStateSha256 !== target("property").rowStateSha256 ||
    owner.source.sourceEnvironment !== envelope.environment ||
    (
      ["sourceRunId", "sourceEnvironment", "sourceSchemaRevision", "sourceEvidenceSha256"] as const
    ).some((key) => owner.source[key] !== sourceRequest[key]) ||
    sourceRequest.sourceRunId !== bindingExpected.sourceRunId ||
    (["id", "hotelId", "externalPropertyId", "rowOrdinal", "rowChecksumSha256"] as const).some(
      (key) => sourceRequest.source[key] !== bindingExpected.source[key],
    )
  )
    return fail("inconsistent_evidence");
  const key = input.verificationKeys.get(envelope.signingKeyId);
  if (
    !/^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(envelope.signingKeyId) ||
    !key ||
    key.type !== "public" ||
    key.asymmetricKeyType !== "ed25519"
  )
    return fail("invalid_verification_key");
  const signature = Buffer.from(input.detachedSignature, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== input.detachedSignature)
    return fail("invalid_signature_encoding");
  if (!verify(null, Buffer.from(`${DOMAIN}envelope\0${input.canonicalPayload}`), key, signature))
    return fail("invalid_signature");
  return Object.freeze({
    outcome: "signature_matches_requires_registry_and_locked_eligibility" as const,
    envelope: Object.freeze(envelope),
  });
}
