import type { AdoptionQueryClient } from "./channexAdoptionTargetRows.js";
import { readDatabaseAttestationTable } from "./databaseAttestation.js";
import { hashLegacyOwnerSetupValue } from "./legacyOwnerSetupReceiptHashes.js";

export type LegacyOwnerSetupTargetIdentity = {
  contractVersion: "legacy-owner-setup-target-identity.v1";
  environment: "local" | "staging" | "preprod" | "production";
  targetIdentitySha256: string;
  databaseName: string;
  databaseOid: number;
};

/** Connection authentication is a caller precondition, NOT established by SQL.
 * expectedDigest must come from independently approved runner configuration.
 * Keep this dedicated transaction/client through later locks and checkpoint. */
export async function verifyLegacyOwnerSetupTargetIdentity(
  client: AdoptionQueryClient,
  artifact: unknown,
  expectedDigest: string,
): Promise<{
  outcome: "target_identity_matches_requires_authorized_runner";
  targetDatabaseSha256: string;
  executable: false;
}> {
  let savepoint = false;
  try {
    const value = structuredClone(artifact) as LegacyOwnerSetupTargetIdentity;
    const keys = [
      "contractVersion",
      "environment",
      "targetIdentitySha256",
      "databaseName",
      "databaseOid",
    ];
    const sha = /^[0-9a-f]{64}$/;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key)) ||
      value.contractVersion !== "legacy-owner-setup-target-identity.v1" ||
      !["local", "staging", "preprod", "production"].includes(value.environment) ||
      typeof value.targetIdentitySha256 !== "string" ||
      !sha.test(value.targetIdentitySha256) ||
      typeof expectedDigest !== "string" ||
      !sha.test(expectedDigest) ||
      typeof value.databaseName !== "string" ||
      !value.databaseName ||
      value.databaseName.includes("\0") ||
      Buffer.byteLength(value.databaseName, "utf8") > 63 ||
      !Number.isSafeInteger(value.databaseOid) ||
      value.databaseOid < 1 ||
      value.databaseOid > 4294967295 ||
      hashLegacyOwnerSetupValue("target-database-identity", value) !== expectedDigest
    )
      throw new Error();
    await client.query("SAVEPOINT vay2017_target_identity");
    savepoint = true;
    await client.query("SET LOCAL search_path = pg_catalog");
    // Retained until the surrounding transaction ends, including after RELEASE.
    await client.query(`LOCK TABLE vayada_migration_evidence.database_attestations
      IN ACCESS SHARE MODE NOWAIT`);
    const table = await readDatabaseAttestationTable(client);
    if (
      !table ||
      table.get("vayada.target_environment") !== value.environment ||
      table.get("vayada.target_identity_sha256") !== value.targetIdentitySha256
    )
      throw new Error();
    const observed = await client.query<{ name: string; oid: string }>(`SELECT
      pg_catalog.current_database() AS name, d.oid::pg_catalog.text AS oid
      FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()`);
    if (
      observed.rows.length !== 1 ||
      observed.rows[0]?.name !== value.databaseName ||
      observed.rows[0]?.oid !== String(value.databaseOid)
    )
      throw new Error();
    await client.query("RELEASE SAVEPOINT vay2017_target_identity");
    return {
      outcome: "target_identity_matches_requires_authorized_runner",
      targetDatabaseSha256: expectedDigest,
      executable: false,
    };
  } catch {
    if (savepoint) {
      try {
        await client.query("ROLLBACK TO SAVEPOINT vay2017_target_identity");
        await client.query("RELEASE SAVEPOINT vay2017_target_identity");
      } catch {
        throw new Error("LEGACY_OWNER_TARGET_IDENTITY_ROLLBACK_FAILED");
      }
    }
    throw new Error("LEGACY_OWNER_TARGET_IDENTITY_INVALID");
  }
}
