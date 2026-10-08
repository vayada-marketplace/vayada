import { createHash } from "node:crypto";
import type pg from "pg";

import {
  planCatalogOwnership,
  type ExistingCatalogSourceLink,
} from "./productionCatalogOwnership.js";
import {
  readProductionCatalogSnapshot,
  type ProductionCatalogSnapshot,
} from "./productionCatalogSnapshotReader.js";
import { readProductionCatalogSourceLinks } from "./productionCatalogTargetReader.js";
import { assertCohortInSource } from "./productionIdentitySnapshotReader.js";
import {
  ProductionMigrationCohortError,
  writeProductionMigrationCohort,
  type ProductionMigrationCohort,
} from "./productionMigrationCohort.js";

type QueryClient = Pick<pg.ClientBase, "query">;
type BindingReaders = {
  snapshot: (client: QueryClient, runId: string) => Promise<ProductionCatalogSnapshot>;
  sourceLinks: (client: QueryClient) => Promise<ExistingCatalogSourceLink[]>;
};
const COHORT_BLOCKERS = new Set(["COHORT_HOTEL_UNRESOLVED", "COHORT_MEMBERSHIP_MISMATCH"]);

/**
 * VAY-1362: binds an approved cohort only after the catalog ownership planner resolves every
 * cohort hotel on the attested snapshot and the target's existing source links. The check runs
 * before the insert, so a refused cohort is never stored and the source run stays usable for a
 * corrected cohort. Identity has not run yet, so owners come from the source users; a missing
 * or ambiguous identity owner link still blocks at the catalog step, before catalog writes.
 * Runs inside the caller's transaction.
 */
export async function bindProductionMigrationCohort(
  client: QueryClient,
  cohort: ProductionMigrationCohort,
  readers: BindingReaders = {
    snapshot: readProductionCatalogSnapshot,
    sourceLinks: readProductionCatalogSourceLinks,
  },
): Promise<void> {
  const { rows, cohort: stored } = await readers.snapshot(client, cohort.sourceRunId);
  if (stored && stored.cohortSha256 !== cohort.cohortSha256)
    throw new ProductionMigrationCohortError(
      "COHORT_CONFLICT",
      "A different migration cohort is already bound to this source run",
    );
  assertCohortInSource(cohort, rows);
  const blockers = planCatalogOwnership(
    rows,
    await readers.sourceLinks(client),
    undefined,
    cohort,
  ).blockers.filter((blocker) => COHORT_BLOCKERS.has(blocker.code));
  if (blockers.length > 0)
    throw new ProductionMigrationCohortError(
      "COHORT_HOTEL_UNRESOLVED",
      `Migration cohort refused: ${blockers
        .map((blocker) => `${blocker.code} ${blocker.source} ${hashed(blocker.sourceId)}`)
        .join("; ")}`,
    );
  await writeProductionMigrationCohort(client, cohort);
}

function hashed(sourceId: string): string {
  return sourceId.startsWith("sha256:")
    ? sourceId
    : `sha256:${createHash("sha256").update(sourceId).digest("hex")}`;
}
