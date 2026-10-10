import type pg from "pg";
import type { WorkOS } from "@workos-inc/node";
import {
  readLegacyOwnerBootstrapSources,
  type OwnerSourceRequest,
} from "./legacyOwnerBootstrapSourceReader.js";
import { readLegacyOwnerBootstrapTargets } from "./legacyOwnerBootstrapTargetReader.js";
import {
  planLegacyOwnerBootstrap,
  type OwnerBootstrapObservation,
} from "./legacyOwnerBootstrapPlan.js";
import {
  parseProductionMigrationCohort,
  type ProductionMigrationCohort,
} from "./productionMigrationCohort.js";

type ReadOnlyWorkos = {
  organizations: Pick<WorkOS["organizations"], "getOrganization">;
  userManagement: Pick<WorkOS["userManagement"], "getUserByExternalId" | "listUsers">;
};

/**
 * Operator-only point-in-time diagnostic. Both pools and the provider client
 * must be independently bound to the approved environments, with full scoped
 * visibility. An organization control is a configuration check, NOT ownership.
 * Source proof request must be authenticated/approved before calling. No CLI,
 * runtime consumer or production invocation is wired by this module.
 */
export async function assessLegacyOwnerBootstrap(
  sourcePool: pg.Pool,
  targetPool: pg.Pool,
  workos: ReadOnlyWorkos,
  input: {
    source: OwnerSourceRequest;
    targetEnvironment: "preprod" | "production";
    controlOrganizationId: string;
    /** The run's approved cohort: the owners are exactly one per cohort PMS hotel. */
    cohort: ProductionMigrationCohort;
  },
  clock: () => Date = () => new Date(),
) {
  try {
    const expected = structuredClone(input),
      startedAt = clock();
    if (
      !/^org_[A-Za-z0-9]+$/.test(expected.controlOrganizationId) ||
      !["preprod", "production"].includes(expected.targetEnvironment) ||
      !Number.isFinite(startedAt.getTime())
    )
      throw Error();
    if (!ownersMatchCohort(expected.cohort, expected.source))
      return {
        outcome: "blocked" as const,
        reason: "cohort_mismatch",
        owners: [],
        executable: false as const,
      };
    // Independent snapshots: never claim cross-database/provider atomicity.
    const source = await snapshot(sourcePool, (client) =>
      readLegacyOwnerBootstrapSources(client, expected.source),
    );
    const target = await snapshot(targetPool, (client) =>
      readLegacyOwnerBootstrapTargets(client, source),
    );
    const control = await workos.organizations.getOrganization(expected.controlOrganizationId);
    if (control.id !== expected.controlOrganizationId) throw Error();
    const providerBindingCounts = new Map<string, number>();
    for (const row of target)
      if (row.providerUserId !== null)
        providerBindingCounts.set(
          row.providerUserId,
          (providerBindingCounts.get(row.providerUserId) ?? 0) + 1,
        );
    const owners: OwnerBootstrapObservation[] = [];
    for (const owner of source) {
      const matches = target.filter((row) => row.ownerId === owner.ownerId);
      if (matches.length !== 1) throw Error();
      const targetState = matches[0]!.target;
      // No provider reads are needed to diagnose a known source/target blocker.
      if (
        owner.sourceOwnership !== "matched" ||
        !["pending", "verified"].includes(owner.sourceStatus) ||
        !["absent", "exact"].includes(targetState)
      ) {
        owners.push({
          ownerId: owner.ownerId,
          sourceStatus: owner.sourceStatus,
          sourceOwnership: owner.sourceOwnership,
          target: targetState,
          providerExternalId: "unknown",
          providerEmail: "unknown",
        });
        continue;
      }
      let external: Awaited<
        ReturnType<ReadOnlyWorkos["userManagement"]["getUserByExternalId"]>
      > | null;
      try {
        external = await workos.userManagement.getUserByExternalId(owner.ownerId);
      } catch (error) {
        if (!error || typeof error !== "object" || !("status" in error) || error.status !== 404)
          throw Error();
        external = null;
      }
      const email = owner.email.trim().toLowerCase();
      const page = await workos.userManagement.listUsers({ email, limit: 100 });
      if (
        page.listMetadata?.after !== null ||
        !Array.isArray(page.data) ||
        page.data.length > 100 ||
        page.data.some(
          (user) =>
            typeof user.email !== "string" ||
            user.email.trim().toLowerCase() !== email ||
            !/^user_[A-Za-z0-9]+$/.test(user.id),
        ) ||
        new Set(page.data.map((user) => user.id)).size !== page.data.length
      )
        throw Error();
      const providerExternalId =
        external === null
          ? "absent"
          : external.externalId === owner.ownerId && /^user_[A-Za-z0-9]+$/.test(external.id)
            ? "exact"
            : "conflict";
      const providerEmail =
        external === null && page.data.length === 0
          ? "absent"
          : external !== null &&
              typeof external.email === "string" &&
              external.email.trim().toLowerCase() === email &&
              page.data.length === 1 &&
              external.id === page.data[0]!.id &&
              page.data[0]!.externalId === owner.ownerId
            ? "same_identity"
            : "conflict";
      const targetProviderConflict =
        targetState === "exact" &&
        ((matches[0]!.providerUserId === null) !== (external === null) ||
          (matches[0]!.providerUserId !== null &&
            (matches[0]!.providerUserId !== external?.id ||
              matches[0]!.providerEmailMatches !== true ||
              providerBindingCounts.get(matches[0]!.providerUserId) !== 1)));
      owners.push({
        ownerId: owner.ownerId,
        sourceStatus: owner.sourceStatus,
        sourceOwnership: owner.sourceOwnership,
        target: targetProviderConflict ? "conflict" : targetState,
        providerExternalId,
        providerEmail,
      });
    }
    return planLegacyOwnerBootstrap(
      {
        ownerIds: expected.source.owners.map((owner) => owner.ownerId),
        sourceRunId: expected.source.sourceRunId,
        targetEnvironment: expected.targetEnvironment,
      },
      {
        sourceRunId: expected.source.sourceRunId,
        targetEnvironment: expected.targetEnvironment,
        observedAt: startedAt.toISOString(),
        expiresAt: new Date(startedAt.getTime() + 15 * 60 * 1000).toISOString(),
        complete: true,
        owners,
      },
      clock(),
    );
  } catch {
    return {
      outcome: "blocked" as const,
      reason: "owner_assessment_failed",
      owners: [],
      executable: false as const,
    };
  }
}

/** VAY-1362 P19: the cohort file is self-consistent (its checksum re-derives from its ID sets),
 * binds the same source run, and its PMS hotels are exactly the requested owner/hotel pairs'
 * hotels, one distinct owner each. Approval of the cohort itself stays the caller's check. */
function ownersMatchCohort(cohort: ProductionMigrationCohort, source: OwnerSourceRequest): boolean {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (
    !cohort ||
    !Array.isArray(source.owners) ||
    source.owners.length < 1 ||
    source.owners.some((owner) => !uuid.test(owner?.hotelId) || !uuid.test(owner?.ownerId)) ||
    new Set(source.owners.map((owner) => owner.ownerId)).size !== source.owners.length
  )
    return false;
  const { cohortSha256, ...approved } = cohort;
  let parsed: ProductionMigrationCohort;
  try {
    parsed = parseProductionMigrationCohort(approved);
  } catch {
    return false;
  }
  const hotels = [...new Set(source.owners.map((owner) => owner?.hotelId))].sort();
  return (
    parsed.cohortSha256 === cohortSha256 &&
    parsed.sourceRunId === source.sourceRunId &&
    hotels.length === source.owners.length &&
    hotels.join(",") === parsed.pmsHotelIds.join(",")
  );
}

async function snapshot<T>(pool: pg.Pool, read: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return await read(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
      throw Error("OWNER_ASSESSMENT_CLEANUP_FAILED");
    } finally {
      client.release(discard);
    }
  }
}
