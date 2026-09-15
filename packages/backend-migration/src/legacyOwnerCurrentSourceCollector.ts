import { createPublicKey, sign, type KeyObject } from "node:crypto";
import { canonicalizeJson } from "./channexAdoptionManifestCrypto.js";
import { readLegacyOwnerCurrentSources } from "./legacyOwnerCurrentSourceReader.js";

type ReaderArgs = Parameters<typeof readLegacyOwnerCurrentSources>;
type Metadata = {
  environment: string;
  sourceRunId: string;
  sourceLedgerSha256: string;
  authDatabaseSha256: string;
  pmsDatabaseSha256: string;
  signingKeyId: string;
};

/** Protected collector, not an executable migration. Pools, source references,
 * metadata and live-purpose keys must come from independent trusted configuration.
 * Never log returned artifacts: they contain exact contacts. No observation input,
 * key loading, endpoint authentication, historical-ledger verification or writes. */
export async function collectLegacyOwnerCurrentSourceEvidence(
  authPool: ReaderArgs[0],
  pmsPool: ReaderArgs[1],
  source: ReaderArgs[2],
  metadata: Metadata,
  keys: { privateKey: KeyObject; publicKey: KeyObject },
  clock: () => Date = () => new Date(),
) {
  try {
    const capturedSource = structuredClone(source);
    const captured = structuredClone(metadata);
    const { privateKey, publicKey } = keys;
    if (
      !["local", "staging", "preprod", "production"].includes(captured.environment) ||
      !/^vay1351-[0-9a-f]{24}$/.test(captured.sourceRunId) ||
      ![captured.sourceLedgerSha256, captured.authDatabaseSha256, captured.pmsDatabaseSha256].every(
        (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
      ) ||
      typeof captured.signingKeyId !== "string" ||
      !/^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(captured.signingKeyId) ||
      Object.keys(captured).sort().join(",") !==
        "authDatabaseSha256,environment,pmsDatabaseSha256,signingKeyId,sourceLedgerSha256,sourceRunId" ||
      privateKey.type !== "private" ||
      publicKey.type !== "public" ||
      privateKey.asymmetricKeyType !== "ed25519" ||
      publicKey.asymmetricKeyType !== "ed25519" ||
      !createPublicKey(privateKey).equals(publicKey)
    )
      throw new Error();
    const started = performance.now();
    let previous = clock().getTime();
    if (!Number.isFinite(previous)) throw new Error();
    const initial = previous;
    const checkedClock = () => {
      const now = clock().getTime();
      if (
        !Number.isFinite(now) ||
        now < previous ||
        now - initial >= 900_000 ||
        performance.now() - started >= 900_000
      )
        throw new Error();
      previous = now;
      return new Date(now);
    };
    const observations = await readLegacyOwnerCurrentSources(
      authPool,
      pmsPool,
      capturedSource,
      checkedClock,
    );
    checkedClock();
    // Build only from this invocation's completed reads, never caller-provided rows.
    const artifacts = observations.map((observation) => {
      const canonicalPayload = canonicalizeJson({
        contractVersion: "legacy-owner-current-source.v1",
        ...captured,
        ...observation,
      });
      const detachedSignature = sign(
        null,
        Buffer.from(
          "vayada:legacy-owner-internal-setup:v1\0current-source-attestation\0" + canonicalPayload,
        ),
        privateKey,
      ).toString("base64url");
      return { canonicalPayload, detachedSignature };
    });
    checkedClock();
    return artifacts;
  } catch {
    throw new Error("LEGACY_OWNER_CURRENT_SOURCE_COLLECTION_FAILED");
  }
}
