import { verify, type KeyObject } from "node:crypto";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";

export const LEGACY_OWNER_SETUP_VERSION = "legacy-owner-internal-setup.v1";
const DOMAIN = "vayada:legacy-owner-internal-setup:v1\0envelope\0";
type Environment = "local" | "staging" | "preprod" | "production";
export type LegacyOwnerSetupEnvelope = {
  contractVersion: typeof LEGACY_OWNER_SETUP_VERSION;
  commandId: string;
  environment: Environment;
  issuedAt: string;
  expiresAt: string;
  commandSha256: string;
  migrationApprovalRecordId: string;
  securityApprovalRecordId: string;
  signingKeyId: string;
};
const fields = [
  "contractVersion",
  "commandId",
  "environment",
  "issuedAt",
  "expiresAt",
  "commandSha256",
  "migrationApprovalRecordId",
  "securityApprovalRecordId",
  "signingKeyId",
].sort();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256 = /^[0-9a-f]{64}$/;

/** Signature only. Trusted caller supplies keys, expected digest/environment and
 * clock. Never derive the expected digest by copying the signed envelope field.
 * No command-schema validation, registry approval, provider call or write. */
export function verifyLegacyOwnerSetupSignature(input: {
  canonicalPayload: string;
  detachedSignature: string;
  verificationKeys: ReadonlyMap<string, KeyObject>;
  expectedCommandSha256: string;
  environment: Environment;
  now: Date;
}): {
  outcome: "signature_matches_requires_registry";
  executable: false;
  envelope: LegacyOwnerSetupEnvelope;
} {
  // All failures are sanitized; no command/contact/signature bytes in errors.
  const fail = (): never => {
    throw new Error("LEGACY_OWNER_SETUP_SIGNATURE_INVALID");
  };
  try {
    const row: unknown = JSON.parse(input.canonicalPayload);
    if (!row || typeof row !== "object" || Array.isArray(row)) return fail();
    const values = row as Record<string, unknown>;
    if (
      Object.keys(values).sort().join("\0") !== fields.join("\0") ||
      fields.some((field) => typeof values[field] !== "string") ||
      canonicalizeJson(values) !== input.canonicalPayload
    )
      return fail();
    const envelope = values as LegacyOwnerSetupEnvelope;
    if (
      envelope.contractVersion !== LEGACY_OWNER_SETUP_VERSION ||
      !["local", "staging", "preprod", "production"].includes(envelope.environment) ||
      envelope.environment !== input.environment ||
      ![
        envelope.commandId,
        envelope.migrationApprovalRecordId,
        envelope.securityApprovalRecordId,
      ].every((id) => uuid.test(id)) ||
      envelope.migrationApprovalRecordId === envelope.securityApprovalRecordId ||
      !sha256.test(input.expectedCommandSha256) ||
      !sha256.test(envelope.commandSha256) ||
      envelope.commandSha256 !== input.expectedCommandSha256
    )
      return fail();
    for (const value of [envelope.issuedAt, envelope.expiresAt]) {
      const parsed = new Date(value);
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(parsed.getTime()) ||
        parsed.toISOString() !== value
      )
        return fail();
    }
    if (
      !Number.isFinite(input.now.getTime()) ||
      envelope.issuedAt >= envelope.expiresAt ||
      envelope.issuedAt > input.now.toISOString() ||
      envelope.expiresAt <= input.now.toISOString() ||
      !/^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(envelope.signingKeyId)
    )
      return fail();
    const key = input.verificationKeys.get(envelope.signingKeyId);
    if (!key || key.type !== "public" || key.asymmetricKeyType !== "ed25519") return fail();
    const signature = Buffer.from(input.detachedSignature, "base64url");
    if (
      signature.length !== 64 ||
      signature.toString("base64url") !== input.detachedSignature ||
      !verify(null, Buffer.from(DOMAIN + input.canonicalPayload, "utf8"), key, signature)
    )
      return fail();
    return { outcome: "signature_matches_requires_registry", executable: false, envelope };
  } catch {
    return fail();
  }
}
