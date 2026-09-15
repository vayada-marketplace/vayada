import { prepareLegacyOwnerSetupTransaction } from "./legacyOwnerSetupTransaction.js";
import { verifyLegacyOwnerSetupTargetIdentity } from "./legacyOwnerSetupTargetIdentity.js";

/** Internal, uncommitted composition. Authenticated endpoint/resource selection,
 * historical source provenance and approved email scope remain runtime inputs.
 * Dedicated bounded READ COMMITTED client; retain all locks through completion.
 * Roll back the whole transaction on failure, discard if rollback is uncertain. */
export async function prepareLegacyOwnerSetupVerifiedTargetTransaction(
  targetIdentity: unknown,
  ...args: Parameters<typeof prepareLegacyOwnerSetupTransaction>
) {
  const [
    client,
    input,
    expected,
    artifacts,
    sourceTrust,
    policy,
    emailScope,
    targetArtifacts,
    clock,
  ] = args;
  let savepoint = false;
  try {
    // Capture every protected value before the first asynchronous operation.
    const identity = structuredClone(targetIdentity);
    const request = { ...input, verificationKeys: new Map(input.verificationKeys) };
    const context = structuredClone(expected);
    const source = structuredClone(artifacts);
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
    if (
      !identity ||
      typeof identity !== "object" ||
      !("environment" in identity) ||
      identity.environment !== context.environment
    )
      throw new Error();
    await client.query("SAVEPOINT vay2017_verified_target");
    savepoint = true;
    // Digest is independent trusted context, never derived from submitted bytes.
    await verifyLegacyOwnerSetupTargetIdentity(client, identity, context.targetDatabaseSha256);
    const result = await prepareLegacyOwnerSetupTransaction(
      client,
      request,
      context,
      source,
      trust,
      authority,
      scope,
      before,
      clock,
    );
    await client.query("RELEASE SAVEPOINT vay2017_verified_target");
    savepoint = false;
    return result;
  } catch {
    if (savepoint) {
      try {
        await client.query("ROLLBACK TO SAVEPOINT vay2017_verified_target");
        await client.query("RELEASE SAVEPOINT vay2017_verified_target");
      } catch {
        throw new Error("LEGACY_OWNER_VERIFIED_TARGET_ROLLBACK_FAILED");
      }
    }
    throw new Error("LEGACY_OWNER_VERIFIED_TARGET_INVALID");
  }
}
