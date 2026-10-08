import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import {
  parseIdentityOwnershipRows,
  type IdentityOwnershipSource,
} from "./productionIdentityOwnershipSource.js";
import type { ProductionMigrationCohort } from "./productionMigrationCohort.js";

// VAY-1362 (engineering/legacy-migration-cohort-scope.md): hotel ownership outside the approved
// cohort takes the quarantine path. Without a cohort nothing is outside it.
export type IdentityCohortScope = Pick<
  ProductionMigrationCohort,
  "bookingHotelIds" | "pmsHotelIds" | "marketplaceHotelIds"
>;

const COHORT_IDS = {
  booking_hotel: "bookingHotelIds",
  pms_hotel: "pmsHotelIds",
  hotel_profile: "marketplaceHotelIds",
} as const;

export function outsideMigrationCohort(
  owner: Pick<IdentityOwnershipSource, "kind" | "resourceType" | "resourceId">,
  cohort?: IdentityCohortScope | null,
): boolean {
  if (!cohort || owner.kind !== "hotel_group") return false;
  const ids = COHORT_IDS[owner.resourceType as keyof typeof COHORT_IDS];
  return !ids || !cohort[ids].includes(owner.resourceId);
}

/** Users whose every hotel ownership lies outside the cohort: they get no access path. */
export function outsideCohortOnlyOwners(
  rows: IdentitySourceRow[],
  cohort?: IdentityCohortScope | null,
): Set<string> {
  const inside = new Set<string>();
  const outside = new Set<string>();
  if (cohort)
    for (const owner of parseIdentityOwnershipRows(rows).owners)
      if (owner.kind === "hotel_group")
        (outsideMigrationCohort(owner, cohort) ? outside : inside).add(owner.userId);
  return new Set([...outside].filter((userId) => !inside.has(userId)));
}
