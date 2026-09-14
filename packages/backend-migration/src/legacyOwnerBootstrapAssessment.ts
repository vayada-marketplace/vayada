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
    // Independent snapshots: never claim cross-database/provider atomicity.
    const source = await snapshot(sourcePool, (client) =>
      readLegacyOwnerBootstrapSources(client, expected.source),
    );
    const target = await snapshot(targetPool, (client) =>
      readLegacyOwnerBootstrapTargets(client, source),
    );
    const control = await workos.organizations.getOrganization(expected.controlOrganizationId);
    if (control.id !== expected.controlOrganizationId) throw Error();
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
        page.data.length === 0
          ? "absent"
          : page.data.length === 1 &&
              external?.id === page.data[0]!.id &&
              page.data[0]!.externalId === owner.ownerId
            ? "same_identity"
            : "conflict";
      owners.push({
        ownerId: owner.ownerId,
        sourceStatus: owner.sourceStatus,
        sourceOwnership: owner.sourceOwnership,
        target: targetState,
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
