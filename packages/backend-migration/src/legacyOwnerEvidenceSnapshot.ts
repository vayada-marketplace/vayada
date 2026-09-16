import type pg from "pg";
import {
  compareLegacyOwnershipBeforeState,
  type LegacyOwnershipFingerprint,
} from "./legacyOwnershipBeforeState.js";
import { verifyLegacyPmsSourceProof, type LegacyPmsSourceProof } from "./legacyPmsSourceProof.js";
import { readLegacyOwnershipTargetEvidence } from "./legacyOwnershipRelationships.js";
import {
  verifyLegacyCurrentOwnerIdentity,
  type LegacyOwnerIdentityEvidence,
  type VerifiedLegacyOwnerSession,
} from "./legacyCurrentOwnerIdentity.js";

export type LegacyOwnerEvidenceRequest = {
  source: LegacyPmsSourceProof;
  target: readonly LegacyOwnershipFingerprint[];
  identity: LegacyOwnerIdentityEvidence;
};

const protectedProperties = new Set([
  "17621565-40b5-4ebc-8727-3a301ac947a2", // Next-native import QA
  "65f6b2fc-c783-4963-9d6b-a85f82319769", // shared staging
]);

/**
 * Read-only evidence prerequisite, NOT approval, eligibility or an access grant.
 * Trusted caller supplies the target pool, authenticated expected evidence and
 * an already backend-auth-verified session; never expose this as a JSON endpoint.
 * All database checks share a fresh REPEATABLE READ, READ ONLY transaction.
 * Its result is point-in-time only: a future executor must repeat checks under
 * its own locks and validate environment, approvals, newer denials, migration
 * disposition, entitlements and claim state. No runtime consumer is wired here.
 */
export async function readLegacyOwnerEvidenceSnapshot(
  pool: pg.Pool,
  request: LegacyOwnerEvidenceRequest,
  verifiedSession: VerifiedLegacyOwnerSession,
): Promise<
  | {
      outcome: "evidence_matches";
      sourceUserStatus: "pending" | "verified";
      userStatus: "active" | "pending";
      organizationStatus: "active" | "suspended";
    }
  | { outcome: "blocked"; reason: string }
> {
  // Freeze the input values across asynchronous reads, not the caller's objects.
  const expected = structuredClone(request);
  const session = structuredClone(verifiedSession);
  if (compareLegacyOwnershipBeforeState(expected.target, expected.target).outcome !== "unchanged")
    return { outcome: "blocked", reason: "invalid_expected" };
  const id = (kind: LegacyOwnershipFingerprint["kind"]) =>
    expected.target.find((row) => row.kind === kind)!.id;
  if (
    expected.source.ownerUserId !== id("user") ||
    expected.identity.userId !== id("user") ||
    expected.identity.organizationId !== id("organization")
  )
    return { outcome: "blocked", reason: "evidence_identity_mismatch" };
  if (
    protectedProperties.has(id("property")) ||
    protectedProperties.has(expected.source.legacyHotelId)
  )
    return { outcome: "blocked", reason: "protected_fixture" };

  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const source = await verifyLegacyPmsSourceProof(client, expected.source, id("user"));
    if (source.outcome === "blocked") return source;
    const target = await readLegacyOwnershipTargetEvidence(
      client,
      expected.target,
      expected.source.legacyHotelId,
    );
    if (target.outcome === "blocked") return target;
    // Last check also revalidates session expiry after the slower snapshot reads.
    const identity = await verifyLegacyCurrentOwnerIdentity(client, expected.identity, session);
    if (identity.outcome === "blocked") return identity;
    return {
      outcome: "evidence_matches",
      sourceUserStatus: source.sourceUserStatus,
      userStatus: identity.userStatus,
      organizationStatus: identity.organizationStatus,
    };
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      discard = true;
      throw error; // Never return success with uncertain transaction cleanup.
    } finally {
      client.release(discard);
    }
  }
}
