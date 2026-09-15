import { createHash } from "node:crypto";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import type { OwnerSourceRequest } from "./legacyOwnerBootstrapSourceReader.js";
import { LEGACY_OWNER_SETUP_VERSION } from "./legacyOwnerSetupSignature.js";

type Environment = "local" | "staging" | "preprod" | "production";
export type LegacyOwnerSetupCommand = {
  contractVersion: typeof LEGACY_OWNER_SETUP_VERSION;
  commandId: string;
  environment: Environment;
  issuedAt: string;
  expiresAt: string;
  targetDatabaseSha256: string;
  sourceRunId: string;
  sourceLedgerSha256: string;
  owners: (OwnerSourceRequest["owners"][number] & {
    email: string;
    name: string | null;
    status: "pending";
    expectedTarget: "absent";
    targetBeforeSha256: string;
    currentEvidenceSha256: string;
    observedAt: string;
  })[];
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
const sourceKeys = [
  "ownerId",
  "hotelId",
  "userOrdinal",
  "hotelOrdinal",
  "userSha256",
  "hotelSha256",
] as const;
const protectedHotels = new Set([
  "17621565-40b5-4ebc-8727-3a301ac947a2",
  "65f6b2fc-c783-4963-9d6b-a85f82319769",
]);
const fail = (): never => {
  throw new Error("LEGACY_OWNER_SETUP_COMMAND_INVALID");
};
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  )
    fail();
}
function time(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return fail();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return fail();
  return parsed;
}
const matches = (pattern: RegExp, value: unknown) =>
  typeof value === "string" && pattern.test(value);

/** Protected in-memory command parser, NOT artifact authentication or authority.
 * Trusted context must be obtained independently, never echoed from the command.
 * Never log input/output: both include contact data. No I/O or side effects. */
export function parseLegacyOwnerSetupCommand(
  canonicalPayload: string,
  expected: { environment: Environment; targetDatabaseSha256: string; source: OwnerSourceRequest },
  now: Date,
): { command: LegacyOwnerSetupCommand; commandSha256: string; executable: false } {
  try {
    const value: unknown = JSON.parse(canonicalPayload);
    exact(value, [
      "contractVersion",
      "commandId",
      "environment",
      "issuedAt",
      "expiresAt",
      "targetDatabaseSha256",
      "sourceRunId",
      "sourceLedgerSha256",
      "owners",
    ]);
    if (
      canonicalizeJson(value) !== canonicalPayload ||
      value.contractVersion !== LEGACY_OWNER_SETUP_VERSION ||
      !matches(uuid, value.commandId) ||
      !["local", "staging", "preprod", "production"].includes(expected.environment) ||
      value.environment !== expected.environment ||
      !matches(sha, expected.targetDatabaseSha256) ||
      value.targetDatabaseSha256 !== expected.targetDatabaseSha256 ||
      !matches(/^vay1351-[0-9a-f]{24}$/, expected.source.sourceRunId) ||
      value.sourceRunId !== expected.source.sourceRunId ||
      !matches(sha, expected.source.ledgerSha256) ||
      value.sourceLedgerSha256 !== expected.source.ledgerSha256
    )
      return fail();
    const cohort = expected.source.owners;
    if (
      !Array.isArray(cohort) ||
      cohort.length !== 8 ||
      new Set(cohort.map((o) => o.ownerId)).size !== 8 ||
      new Set(cohort.map((o) => o.hotelId)).size !== 8 ||
      cohort.some(
        (o) =>
          !matches(uuid, o.ownerId) ||
          !matches(uuid, o.hotelId) ||
          protectedHotels.has(o.hotelId) ||
          !matches(sha, o.userSha256) ||
          !matches(sha, o.hotelSha256) ||
          !Number.isSafeInteger(o.userOrdinal) ||
          o.userOrdinal < 1 ||
          !Number.isSafeInteger(o.hotelOrdinal) ||
          o.hotelOrdinal < 1,
      )
    )
      return fail();
    const issued = time(value.issuedAt),
      expires = time(value.expiresAt);
    if (
      !Number.isFinite(now.getTime()) ||
      issued > now.getTime() ||
      expires <= now.getTime() ||
      !Array.isArray(value.owners) ||
      value.owners.length < 1 ||
      value.owners.length > 8
    )
      return fail();
    let previous = "";
    const emails = new Set<string>();
    for (const owner of value.owners) {
      exact(owner, [
        ...sourceKeys,
        "email",
        "name",
        "status",
        "expectedTarget",
        "targetBeforeSha256",
        "currentEvidenceSha256",
        "observedAt",
      ]);
      const source = cohort.find((o) => o.ownerId === owner.ownerId);
      if (
        !source ||
        sourceKeys.some((key) => owner[key] !== source[key]) ||
        source.ownerId <= previous ||
        owner.status !== "pending" ||
        owner.expectedTarget !== "absent" ||
        !matches(sha, owner.targetBeforeSha256) ||
        !matches(sha, owner.currentEvidenceSha256) ||
        typeof owner.email !== "string" ||
        owner.email.length > 254 ||
        owner.email.includes("\0") ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner.email) ||
        (owner.name !== null &&
          (typeof owner.name !== "string" ||
            !owner.name.trim() ||
            owner.name.length > 256 ||
            owner.name.includes("\0")))
      )
        return fail();
      const observed = time(owner.observedAt);
      if (observed > issued || expires - observed > 900_000 || emails.has(owner.email))
        return fail();
      emails.add(owner.email);
      previous = source.ownerId;
    }
    return {
      command: value as LegacyOwnerSetupCommand,
      commandSha256: createHash("sha256")
        .update("vayada:legacy-owner-internal-setup:v1\0command\0")
        .update(canonicalPayload)
        .digest("hex"),
      executable: false,
    };
  } catch {
    return fail();
  }
}
