import { verify, type KeyObject } from "node:crypto";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import { verifyLegacyOwnerSetupRequest } from "./legacyOwnerSetupRequest.js";
import { hashLegacyOwnerSetupValue } from "./legacyOwnerSetupReceiptHashes.js";

const domain = "vayada:legacy-owner-internal-setup:v1\0current-source-attestation\0";
const fields = [
  "contractVersion",
  "environment",
  "sourceRunId",
  "sourceLedgerSha256",
  "ownerId",
  "hotelId",
  "authDatabaseSha256",
  "pmsDatabaseSha256",
  "authObservedAt",
  "pmsObservedAt",
  "sourceStatus",
  "email",
  "name",
  "signingKeyId",
].sort();
const time = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error();
  return value;
};

/** Authenticates collector statements, NOT their query execution or write authority.
 * Trusted environment/database pins and live-purpose public keys MUST come from
 * independent operator configuration. Never log artifacts, contacts or signatures. */
export function verifyLegacyOwnerCurrentSourceEvidence(
  input: Parameters<typeof verifyLegacyOwnerSetupRequest>[0],
  expected: Parameters<typeof verifyLegacyOwnerSetupRequest>[1],
  artifacts: readonly { canonicalPayload: string; detachedSignature: string }[],
  trust: {
    environment: string;
    authDatabaseSha256: string;
    pmsDatabaseSha256: string;
    verificationKeys: ReadonlyMap<string, KeyObject>;
  },
  now: Date,
) {
  try {
    const { command, commandSha256 } = verifyLegacyOwnerSetupRequest(input, expected, now);
    if (
      trust.environment !== command.environment ||
      ![trust.authDatabaseSha256, trust.pmsDatabaseSha256].every((v) => /^[0-9a-f]{64}$/.test(v)) ||
      !Array.isArray(artifacts) ||
      artifacts.length !== command.owners.length
    )
      throw new Error();
    const seen = new Set<string>();
    for (const artifact of artifacts) {
      const row: unknown = JSON.parse(artifact.canonicalPayload);
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).sort().join("\0") !== fields.join("\0") ||
        canonicalizeJson(row) !== artifact.canonicalPayload
      )
        throw new Error();
      const value = row as Record<string, unknown>;
      const owner = command.owners.find((o) => o.ownerId === value.ownerId);
      if (
        !owner ||
        seen.has(owner.ownerId) ||
        value.contractVersion !== "legacy-owner-current-source.v1" ||
        value.environment !== command.environment ||
        value.sourceRunId !== command.sourceRunId ||
        value.sourceLedgerSha256 !== command.sourceLedgerSha256 ||
        value.hotelId !== owner.hotelId ||
        value.email !== owner.email ||
        value.name !== owner.name ||
        value.authDatabaseSha256 !== trust.authDatabaseSha256 ||
        value.pmsDatabaseSha256 !== trust.pmsDatabaseSha256 ||
        !["pending", "verified"].includes(value.sourceStatus as string) ||
        typeof value.signingKeyId !== "string" ||
        !/^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(value.signingKeyId) ||
        hashLegacyOwnerSetupValue("current-source-evidence", row) !== owner.currentEvidenceSha256
      )
        throw new Error();
      const observed = [time(value.authObservedAt), time(value.pmsObservedAt)].sort();
      if (observed[0] !== owner.observedAt || observed[1]! > command.issuedAt) throw new Error();
      const key = trust.verificationKeys.get(value.signingKeyId);
      const signature = Buffer.from(artifact.detachedSignature, "base64url");
      if (
        !key ||
        key.type !== "public" ||
        key.asymmetricKeyType !== "ed25519" ||
        signature.length !== 64 ||
        signature.toString("base64url") !== artifact.detachedSignature ||
        !verify(null, Buffer.from(domain + artifact.canonicalPayload), key, signature)
      )
        throw new Error();
      seen.add(owner.ownerId);
    }
    return {
      outcome: "current_source_attestations_match" as const,
      executable: false as const,
      commandSha256,
      ownerCount: seen.size,
    };
  } catch {
    throw new Error("LEGACY_OWNER_CURRENT_SOURCE_EVIDENCE_INVALID");
  }
}
