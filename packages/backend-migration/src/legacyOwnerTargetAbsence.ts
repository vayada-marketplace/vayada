import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import { planLegacyOwnerEmailIndex } from "./legacyOwnerEmailIndexPlan.js";
import { verifyLegacyOwnerSetupRequest } from "./legacyOwnerSetupRequest.js";
import { hashLegacyOwnerSetupValue } from "./legacyOwnerSetupReceiptHashes.js";

const fields = [
  "contractVersion",
  "normalizationVersion",
  "environment",
  "targetDatabaseSha256",
  "ownerId",
  "normalizedEmailSha256",
  "emailScopeSha256",
  "observedAt",
  "userIdPresent",
  "userEmailPresent",
  "externalUserIdPresent",
  "externalEmailPresent",
].sort();

/** Authenticates reviewed absence content through the signed command, NOT the
 * actual target connection or an earlier query. Compare returned hashes with
 * PostgreSQL observations under retained locks before any non-replay write. */
export function verifyLegacyOwnerTargetAbsence(
  input: Parameters<typeof verifyLegacyOwnerSetupRequest>[0],
  expected: Parameters<typeof verifyLegacyOwnerSetupRequest>[1],
  artifacts: readonly string[],
  emailScope: readonly string[],
  now: Date,
): { ownerId: string; normalizedEmailSha256: string }[] {
  try {
    const { command } = verifyLegacyOwnerSetupRequest(input, expected, now);
    const scopeHash = planLegacyOwnerEmailIndex(emailScope).scopeSha256;
    if (!Array.isArray(artifacts) || artifacts.length !== command.owners.length) throw new Error();
    const seen = new Set<string>();
    const hashes = new Set<string>();
    const owners = artifacts.map((payload) => {
      const row = JSON.parse(payload) as Record<string, unknown>;
      if (
        !row ||
        Array.isArray(row) ||
        typeof row !== "object" ||
        Object.keys(row).sort().join("\0") !== fields.join("\0") ||
        canonicalizeJson(row) !== payload
      )
        throw new Error();
      const owner = command.owners.find((o) => o.ownerId === row.ownerId);
      if (
        !owner ||
        seen.has(owner.ownerId) ||
        row.contractVersion !== "legacy-owner-target-absence.v1" ||
        row.normalizationVersion !== "legacy-owner-email-index.v1" ||
        row.environment !== command.environment ||
        row.targetDatabaseSha256 !== command.targetDatabaseSha256 ||
        row.emailScopeSha256 !== scopeHash ||
        typeof row.normalizedEmailSha256 !== "string" ||
        !emailScope.includes(row.normalizedEmailSha256) ||
        hashes.has(row.normalizedEmailSha256) ||
        ["userIdPresent", "userEmailPresent", "externalUserIdPresent", "externalEmailPresent"].some(
          (key) => row[key] !== false,
        ) ||
        hashLegacyOwnerSetupValue("target-absence-evidence", row) !== owner.targetBeforeSha256 ||
        typeof row.observedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.observedAt) ||
        !Number.isFinite(Date.parse(row.observedAt)) ||
        new Date(row.observedAt).toISOString() !== row.observedAt ||
        row.observedAt > command.issuedAt ||
        Date.parse(command.expiresAt) - Date.parse(row.observedAt) > 900_000
      )
        throw new Error();
      seen.add(owner.ownerId);
      hashes.add(row.normalizedEmailSha256);
      return { ownerId: owner.ownerId, normalizedEmailSha256: row.normalizedEmailSha256 };
    });
    return owners.sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  } catch {
    throw new Error("LEGACY_OWNER_TARGET_ABSENCE_INVALID");
  }
}
