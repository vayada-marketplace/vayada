import { createHash } from "node:crypto";
import type pg from "pg";

import { stableJson } from "./productionIdentitySourceValidation.js";

// VAY-1362 cohort input (engineering/legacy-migration-cohort-scope.md). The catalog-group
// check COHORT_MEMBERSHIP_MISMATCH needs catalog ownership and lands with the catalog PR.
export type ProductionMigrationCohortInput = {
  sourceRunId: string;
  bookingHotelIds: string[];
  pmsHotelIds: string[];
  marketplaceHotelIds: string[];
  approvalProofSha256: string;
};
export type ProductionMigrationCohort = ProductionMigrationCohortInput & { cohortSha256: string };
export type ProductionMigrationCohortErrorCode =
  | "INVALID_COHORT"
  | "COHORT_CONFLICT"
  | "COHORT_HOTEL_NOT_IN_SOURCE";

export class ProductionMigrationCohortError extends Error {
  constructor(
    readonly code: ProductionMigrationCohortErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProductionMigrationCohortError";
  }
}

type QueryClient = Pick<pg.ClientBase, "query">;
const KEYS = "approvalProofSha256,bookingHotelIds,marketplaceHotelIds,pmsHotelIds,sourceRunId";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validates a reviewed cohort file and returns its canonical form and checksum. */
export function parseProductionMigrationCohort(value: unknown): ProductionMigrationCohort {
  const invalid = (detail: string) =>
    new ProductionMigrationCohortError("INVALID_COHORT", `Migration cohort ${detail}`);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid("is not an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== KEYS) throw invalid(`must have exactly ${KEYS}`);
  const { sourceRunId, approvalProofSha256 } = input;
  if (typeof sourceRunId !== "string" || !/^vay1351-[0-9a-f]{24}$/.test(sourceRunId))
    throw invalid("sourceRunId is invalid");
  if (typeof approvalProofSha256 !== "string" || !/^[0-9a-f]{64}$/.test(approvalProofSha256))
    throw invalid("approvalProofSha256 is invalid");
  const ids = (key: string, required: boolean): string[] => {
    const list = input[key];
    if (!Array.isArray(list) || list.some((id) => typeof id !== "string" || !UUID.test(id)))
      throw invalid(`${key} must be lowercase UUIDs`);
    const sorted = [...new Set(list as string[])].sort();
    if (sorted.length !== list.length) throw invalid(`${key} has duplicates`);
    if (required && sorted.length === 0) throw invalid(`${key} is empty`);
    return sorted;
  };
  const sets = {
    bookingHotelIds: ids("bookingHotelIds", true),
    pmsHotelIds: ids("pmsHotelIds", false),
    marketplaceHotelIds: ids("marketplaceHotelIds", false),
  };
  const cohortSha256 = createHash("sha256").update(stableJson(sets)).digest("hex");
  return { sourceRunId, ...sets, approvalProofSha256, cohortSha256 };
}

/** Insert-once: the same cohort is a no-op; any other cohort for the run is a conflict. */
export async function writeProductionMigrationCohort(
  client: QueryClient,
  cohort: ProductionMigrationCohort,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.production_migration_cohorts
       (source_run_id, cohort_sha256, booking_hotel_ids, pms_hotel_ids, marketplace_hotel_ids,
        approval_proof_sha256)
     VALUES ($1, $2, $3::uuid[], $4::uuid[], $5::uuid[], $6)
     ON CONFLICT (source_run_id) DO NOTHING`,
    [
      cohort.sourceRunId,
      cohort.cohortSha256,
      cohort.bookingHotelIds,
      cohort.pmsHotelIds,
      cohort.marketplaceHotelIds,
      cohort.approvalProofSha256,
    ],
  );
  const stored = await readProductionMigrationCohort(client, cohort.sourceRunId);
  if (
    stored?.cohortSha256 !== cohort.cohortSha256 ||
    stored.approvalProofSha256 !== cohort.approvalProofSha256
  )
    throw new ProductionMigrationCohortError(
      "COHORT_CONFLICT",
      "A different migration cohort is already bound to this source run",
    );
}

/** Loads and re-verifies the bound cohort; null means the run has no cohort. */
export async function readProductionMigrationCohort(
  client: QueryClient,
  sourceRunId: string,
): Promise<ProductionMigrationCohort | null> {
  const result = await client.query<ProductionMigrationCohort>(
    `SELECT source_run_id AS "sourceRunId", cohort_sha256 AS "cohortSha256",
            booking_hotel_ids::text[] AS "bookingHotelIds", pms_hotel_ids::text[] AS "pmsHotelIds",
            marketplace_hotel_ids::text[] AS "marketplaceHotelIds",
            approval_proof_sha256 AS "approvalProofSha256"
       FROM platform.production_migration_cohorts WHERE source_run_id = $1`,
    [sourceRunId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const { cohortSha256, ...input } = row;
  const cohort = parseProductionMigrationCohort(input);
  if (cohort.cohortSha256 !== cohortSha256)
    throw new ProductionMigrationCohortError(
      "INVALID_COHORT",
      "Stored migration cohort is corrupt",
    );
  return cohort;
}
