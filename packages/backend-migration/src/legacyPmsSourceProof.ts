import type { AdoptionQueryClient } from "./channexAdoptionTargetRows.js";
import { readSourceLedger } from "./channexAdoptionEvidence.js";
import { hashSourceLedger } from "./channexAdoptionManifestCrypto.js";
import { readProductionIdentitySnapshot } from "./productionIdentitySnapshotReader.js";
import { parseIdentityOwnershipRows } from "./productionIdentityOwnershipSource.js";

export type LegacyPmsSourceProof = {
  sourceRunId: string;
  sourceEnvironment: string;
  sourceSchemaRevision: string;
  sourceEvidenceSha256: string;
  legacyHotelId: string;
  ownerUserId: string;
  hotelRowOrdinal: number;
  userRowOrdinal: number;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Verify snapshot provenance and the historical PMS owner association only.
 * The expected proof must be approval/signature-bound by the caller. Requires
 * one caller-owned REPEATABLE READ or SERIALIZABLE transaction; READ COMMITTED
 * is insufficient across these reads. Does not open/commit transactions or write.
 * A matching historical owner is NOT a verified current WorkOS identity, nor
 * permission to access PMS/Marketplace or enable an old Channex connection.
 */
export async function verifyLegacyPmsSourceProof(
  client: AdoptionQueryClient,
  expected: LegacyPmsSourceProof,
  targetOwnerId: string,
): Promise<
  | { outcome: "source_matches"; sourceUserStatus: "pending" | "verified" }
  | { outcome: "blocked"; reason: string }
> {
  if (
    !/^vay1351-[0-9a-f]{24}$/.test(expected.sourceRunId) ||
    !/^[0-9a-f]{64}$/.test(expected.sourceEvidenceSha256) ||
    !UUID.test(expected.legacyHotelId) ||
    !UUID.test(expected.ownerUserId) ||
    expected.ownerUserId !== targetOwnerId ||
    !expected.sourceEnvironment?.trim() ||
    !expected.sourceSchemaRevision?.trim() ||
    !Number.isSafeInteger(expected.hotelRowOrdinal) ||
    expected.hotelRowOrdinal < 1 ||
    !Number.isSafeInteger(expected.userRowOrdinal) ||
    expected.userRowOrdinal < 1
  )
    return { outcome: "blocked", reason: "invalid_source_proof" };

  const ledger = await readSourceLedger(client, expected.sourceRunId);
  if (
    ledger.run.run_id !== expected.sourceRunId ||
    ledger.run.environment !== expected.sourceEnvironment ||
    ledger.run.source_schema_revision !== expected.sourceSchemaRevision ||
    hashSourceLedger(ledger) !== expected.sourceEvidenceSha256
  )
    return { outcome: "blocked", reason: "source_ledger_mismatch" };
  // Existing reader validates completed inventory, every source/table ledger,
  // row ordinals and raw PostgreSQL JSON checksums before returning parsed rows.
  const snapshot = await readProductionIdentitySnapshot(client, expected.sourceRunId);
  const hotels = snapshot.rows.filter(
    (row) =>
      row.sourceDatabase === "pms" &&
      row.sourceTable === "hotels" &&
      row.data["id"] === expected.legacyHotelId,
  );
  const users = snapshot.rows.filter(
    (row) =>
      row.sourceDatabase === "auth" &&
      row.sourceTable === "users" &&
      row.data["id"] === expected.ownerUserId,
  );
  if (
    hotels.length !== 1 ||
    users.length !== 1 ||
    hotels[0]!.rowOrdinal !== expected.hotelRowOrdinal ||
    users[0]!.rowOrdinal !== expected.userRowOrdinal
  )
    return { outcome: "blocked", reason: "source_rows_not_exact" };
  const ownership = parseIdentityOwnershipRows(hotels);
  if (
    ownership.blockers.length ||
    ownership.owners.length !== 1 ||
    ownership.owners[0]!.userId !== expected.ownerUserId ||
    ownership.owners[0]!.status !== "active"
  )
    return { outcome: "blocked", reason: "source_owner_mismatch" };
  const user = users[0]!.data;
  if (user["type"] !== "hotel" || (user["status"] !== "pending" && user["status"] !== "verified"))
    return { outcome: "blocked", reason: "source_user_not_eligible" };
  return { outcome: "source_matches", sourceUserStatus: user["status"] };
}
