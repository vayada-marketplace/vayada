import type pg from "pg";
import { prepareLegacyOwnerSetupVerifiedTargetTransaction } from "./legacyOwnerSetupVerifiedTargetTransaction.js";
import { verifyLegacyOwnerCurrentSourceEvidence } from "./legacyOwnerCurrentSourceEvidence.js";
import { inspectLegacyOwnerSetupReplay } from "./legacyOwnerSetupReplay.js";

type Preparation = Parameters<typeof prepareLegacyOwnerSetupVerifiedTargetTransaction>;

/** Internal commit boundary, not a production CLI or access grant.
 * Trusted runtime owns authenticated pool, historical provenance and approved scope.
 * No automatic retry: COMMIT errors require separate exact receipt inspection.
 * Never log arguments or receipts (protected identity evidence). */
export async function commitLegacyOwnerSetup(
  pool: Pick<pg.Pool, "connect">,
  targetIdentity: Preparation[0],
  input: Preparation[2],
  expected: Preparation[3],
  artifacts: Preparation[4],
  sourceTrust: Preparation[5],
  policy: Preparation[6],
  emailScope: Preparation[7],
  targetArtifacts: Preparation[8],
  clock: () => Date = () => new Date(),
) {
  let dispatched = false;
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
    const scope = [...emailScope],
      before = [...targetArtifacts];
    const started = performance.now();
    let previous = clock().getTime();
    if (!Number.isFinite(previous)) throw Error();
    const checkedClock = () => {
      const now = clock().getTime();
      if (!Number.isFinite(now) || now < previous || performance.now() - started >= 900_000)
        throw Error();
      previous = now;
      return new Date(now);
    };
    const verify = () =>
      verifyLegacyOwnerCurrentSourceEvidence(request, context, evidence, trust, checkedClock());
    verify();
    const client = await pool.connect();
    try {
      await client.query("ROLLBACK");
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(
        "SET LOCAL search_path=pg_catalog; SET LOCAL row_security=off; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; SET LOCAL synchronous_commit=on",
      );
      const prepared = await prepareLegacyOwnerSetupVerifiedTargetTransaction(
        identity,
        client,
        request,
        context,
        evidence,
        trust,
        authority,
        scope,
        before,
        checkedClock,
      );
      const final = await inspectLegacyOwnerSetupReplay(
        client,
        request,
        context,
        authority,
        checkedClock,
      );
      if (!final.receipt) throw Error();
      verify();
      dispatched = true;
      const result = await client.query("COMMIT");
      if (result.command !== "COMMIT") throw Error();
      return { outcome: "commit_acknowledged" as const, executable: false as const, prepared };
    } catch {
      if (!dispatched) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* Connection discarded below. */
        }
      }
      throw Error();
    } finally {
      client.release(true);
    }
  } catch {
    throw Error(
      dispatched ? "LEGACY_OWNER_SETUP_COMMIT_INDETERMINATE" : "LEGACY_OWNER_SETUP_NOT_COMMITTED",
    );
  }
}
