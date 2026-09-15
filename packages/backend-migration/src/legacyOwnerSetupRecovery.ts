import type pg from "pg";
import { verifyLegacyOwnerCurrentSourceEvidence } from "./legacyOwnerCurrentSourceEvidence.js";
import { verifyLegacyOwnerSetupTargetIdentity } from "./legacyOwnerSetupTargetIdentity.js";
import { inspectLegacyOwnerSetupReplay } from "./legacyOwnerSetupReplay.js";

/** Inspection only, never automatic retry. Use a separately authenticated dedicated
 * recovery pool with bounded acquisition, NOT the uncertain writer connection.
 * Caller independently authenticates historical provenance and trusted policy.
 * Protected inputs must never be logged. No users, receipts or provider writes. */
export async function inspectLegacyOwnerSetupRecovery(
  pool: Pick<pg.Pool, "connect">,
  targetIdentity: unknown,
  input: Parameters<typeof verifyLegacyOwnerCurrentSourceEvidence>[0],
  expected: Parameters<typeof verifyLegacyOwnerCurrentSourceEvidence>[1],
  artifacts: Parameters<typeof verifyLegacyOwnerCurrentSourceEvidence>[2],
  sourceTrust: Parameters<typeof verifyLegacyOwnerCurrentSourceEvidence>[3],
  policy: Parameters<typeof inspectLegacyOwnerSetupReplay>[3],
  clock: () => Date = () => new Date(),
) {
  try {
    const identity = structuredClone(targetIdentity);
    const request = { ...input, verificationKeys: new Map(input.verificationKeys) };
    const context = structuredClone(expected),
      evidence = structuredClone(artifacts);
    const trust = { ...sourceTrust, verificationKeys: new Map(sourceTrust.verificationKeys) };
    const authority = {
      ...policy,
      signingPrincipals: new Map(policy.signingPrincipals),
      actors: structuredClone(new Map(policy.actors)),
      singleHumanDualAuthority: policy.singleHumanDualAuthority
        ? { ...policy.singleHumanDualAuthority }
        : undefined,
    };
    const started = performance.now();
    let previous = clock().getTime();
    if (
      !Number.isFinite(previous) ||
      !identity ||
      typeof identity !== "object" ||
      !("environment" in identity) ||
      identity.environment !== context.environment
    )
      throw new Error();
    const checkedClock = () => {
      const now = clock().getTime();
      if (!Number.isFinite(now) || now < previous || performance.now() - started >= 900_000)
        throw new Error();
      previous = now;
      return new Date(now);
    };
    const verifySource = () =>
      verifyLegacyOwnerCurrentSourceEvidence(request, context, evidence, trust, checkedClock());
    verifySource();
    const client = await pool.connect();
    let discard = false;
    try {
      await client.query("ROLLBACK");
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(
        "SET LOCAL search_path=pg_catalog; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'",
      );
      verifySource();
      await verifyLegacyOwnerSetupTargetIdentity(client, identity, context.targetDatabaseSha256);
      const result = await inspectLegacyOwnerSetupReplay(
        client,
        request,
        context,
        authority,
        checkedClock,
      );
      verifySource();
      return {
        outcome: result.receipt
          ? ("matching_receipt_found" as const)
          : ("no_receipt_observed" as const),
        executable: false as const,
        receipt: result.receipt,
      };
    } finally {
      try {
        await client.query("ROLLBACK");
        verifySource();
      } catch {
        discard = true;
        throw new Error();
      } finally {
        client.release(discard);
      }
    }
  } catch {
    throw new Error("LEGACY_OWNER_SETUP_RECOVERY_FAILED");
  }
}
