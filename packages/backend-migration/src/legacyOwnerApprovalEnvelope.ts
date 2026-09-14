import { createHash, verify, type KeyObject } from "node:crypto";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import type { LegacyOwnerEvidenceRequest } from "./legacyOwnerEvidenceSnapshot.js";

export const LEGACY_OWNER_APPROVAL_VERSION = "legacy-pms-owner-evidence.v1";
const DOMAIN = "vayada:legacy-pms-owner-evidence:v1\0";
type Environment = "local" | "staging" | "preprod" | "production";
export type LegacyOwnerApprovalEnvelope = {
  contractVersion: typeof LEGACY_OWNER_APPROVAL_VERSION;
  commandId: string;
  environment: Environment;
  issuedAt: string;
  expiresAt: string;
  evidenceSha256: string;
  migrationApprovalRecordId: string;
  securityApprovalRecordId: string;
  signingKeyId: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEYS = [
  "contractVersion",
  "commandId",
  "environment",
  "issuedAt",
  "expiresAt",
  "evidenceSha256",
  "migrationApprovalRecordId",
  "securityApprovalRecordId",
  "signingKeyId",
];

/** Domain-separated full evidence binding; does not validate the evidence itself. */
export function hashLegacyOwnerApprovalEvidence(evidence: LegacyOwnerEvidenceRequest): string {
  return createHash("sha256")
    .update(`${DOMAIN}evidence\0`)
    .update(canonicalizeJson(evidence))
    .digest("hex");
}

/**
 * Cryptographic envelope verification ONLY. A signature is not current approval.
 * The consumer must read both immutable authority records and revocations from
 * its trusted registry, match their full subject/environment/expiry, enforce
 * signer/executor/human separation, and recheck evidence/restrictions under locks.
 * This deliberately does not call the evidence reader, grant access or mutate.
 * Verification keys, expected environment and clock are trusted server inputs.
 */
export function verifyLegacyOwnerApprovalEnvelope(input: {
  canonicalPayload: string;
  detachedSignature: string;
  verificationKeys: ReadonlyMap<string, KeyObject>;
  environment: Environment;
  evidence: LegacyOwnerEvidenceRequest;
  now: Date;
}): { outcome: "signature_matches_requires_registry"; envelope: LegacyOwnerApprovalEnvelope } {
  const fail = (reason: string): never => {
    throw new Error(`Legacy owner approval: ${reason}`);
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
    Object.keys(row).sort().join("\0") !== [...KEYS].sort().join("\0") ||
    KEYS.some((key) => typeof row[key] !== "string")
  )
    return fail("invalid_fields");
  // Only canonical bytes are accepted: duplicate keys, alternative numeric
  // spellings and whitespace cannot create multiple representations to sign.
  if (canonicalizeJson(row) !== input.canonicalPayload) return fail("noncanonical_payload");
  const envelope = row as LegacyOwnerApprovalEnvelope;
  if (envelope.contractVersion !== LEGACY_OWNER_APPROVAL_VERSION) return fail("wrong_contract");
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
  const timestamp = (value: string) => {
    const parsed = new Date(value);
    return (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString() === value
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
    !/^[0-9a-f]{64}$/.test(envelope.evidenceSha256) ||
    envelope.evidenceSha256 !== hashLegacyOwnerApprovalEvidence(input.evidence)
  )
    return fail("evidence_mismatch");
  if (!/^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(envelope.signingKeyId)) return fail("invalid_key_id");
  const key = input.verificationKeys.get(envelope.signingKeyId);
  if (!key || key.type !== "public" || key.asymmetricKeyType !== "ed25519")
    return fail("invalid_verification_key");
  const signature = Buffer.from(input.detachedSignature, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== input.detachedSignature)
    return fail("invalid_signature_encoding");
  if (
    !verify(
      null,
      Buffer.from(`${DOMAIN}envelope\0${input.canonicalPayload}`, "utf8"),
      key,
      signature,
    )
  )
    return fail("invalid_signature");
  return { outcome: "signature_matches_requires_registry", envelope };
}
