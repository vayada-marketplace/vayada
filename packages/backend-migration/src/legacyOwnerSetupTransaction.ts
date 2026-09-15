import type { AdoptionQueryClient } from "./channexAdoptionTargetRows.js";
import { verifyLegacyOwnerCurrentSourceEvidence } from "./legacyOwnerCurrentSourceEvidence.js";
import { inspectLegacyOwnerSetupReplay } from "./legacyOwnerSetupReplay.js";
import { lockAndCheckLegacyOwnerSetupTargets } from "./legacyOwnerSetupTargetLocks.js";
import { writeLegacyOwnerSetupCheckpoint } from "./legacyOwnerSetupCheckpoint.js";

/** Internal transaction composition, NOT an authorized runtime/CLI.
 * Caller independently authenticates historical ledger/rows, actual target DB,
 * reviewed target-before artifacts and eight-email scope before calling.
 * Dedicated bounded READ COMMITTED transaction; no network/provider I/O here.
 * Retain locks until outer completion. Roll back ALL on failure; discard the
 * connection if rollback fails. Never log inputs (protected contact evidence).
 */
export async function prepareLegacyOwnerSetupTransaction(
  client: AdoptionQueryClient,
  input: Parameters<typeof verifyLegacyOwnerCurrentSourceEvidence>[0],
  expected: Parameters<typeof verifyLegacyOwnerCurrentSourceEvidence>[1],
  artifacts: Parameters<typeof verifyLegacyOwnerCurrentSourceEvidence>[2],
  sourceTrust: Parameters<typeof verifyLegacyOwnerCurrentSourceEvidence>[3],
  policy: Parameters<typeof inspectLegacyOwnerSetupReplay>[3],
  emailScope: readonly string[],
  clock: () => Date = () => new Date(),
) {
  let savepoint = false;
  try {
    const request = { ...input, verificationKeys: new Map(input.verificationKeys) };
    const context = structuredClone(expected);
    const evidence = structuredClone(artifacts);
    const trust = { ...sourceTrust, verificationKeys: new Map(sourceTrust.verificationKeys) };
    const scope = [...emailScope];
    const authority = {
      ...policy,
      signingPrincipals: new Map(policy.signingPrincipals),
      actors: structuredClone(new Map(policy.actors)),
      singleHumanDualAuthority: policy.singleHumanDualAuthority
        ? { ...policy.singleHumanDualAuthority }
        : undefined,
    };
    const verifySource = () =>
      verifyLegacyOwnerCurrentSourceEvidence(request, context, evidence, trust, clock());
    verifySource();
    await client.query("SAVEPOINT vay2017_setup_transaction");
    savepoint = true;
    const replay = await inspectLegacyOwnerSetupReplay(client, request, context, authority, clock);
    if (replay.receipt) {
      verifySource();
      await client.query("RELEASE SAVEPOINT vay2017_setup_transaction");
      savepoint = false;
      return { outcome: "matching_receipt_found" as const, receipt: replay.receipt };
    }
    await lockAndCheckLegacyOwnerSetupTargets(
      client,
      request.commandPayload,
      context,
      scope,
      clock,
    );
    verifySource();
    const checkpoint = await writeLegacyOwnerSetupCheckpoint(
      client,
      request.commandPayload,
      context,
      replay.audit,
      clock(),
    );
    // Expiry during persistence rolls back users AND receipt, not only the last helper.
    verifySource();
    await client.query("RELEASE SAVEPOINT vay2017_setup_transaction");
    savepoint = false;
    return checkpoint;
  } catch {
    if (savepoint) {
      try {
        await client.query("ROLLBACK TO SAVEPOINT vay2017_setup_transaction");
        await client.query("RELEASE SAVEPOINT vay2017_setup_transaction");
      } catch {
        throw new Error("LEGACY_OWNER_SETUP_TRANSACTION_ROLLBACK_FAILED");
      }
    }
    throw new Error("LEGACY_OWNER_SETUP_TRANSACTION_INVALID");
  }
}
