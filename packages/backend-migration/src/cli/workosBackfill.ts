#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { WorkOS } from "@workos-inc/node";

import {
  createPgWorkosBackfillRepository,
  runWorkosBackfill,
  type WorkosBackfillClient,
  type WorkosBackfillCohort,
  type WorkosBackfillMode,
  type WorkosBackfillSummary,
} from "../workosBackfill.js";

function parseArgs(argv: string[]): {
  mode: WorkosBackfillMode;
  connectionString: string;
  workosApiKey: string;
  cohortManifestPath: string;
  confirm: string;
} {
  const args = argv.slice(2);
  let mode: WorkosBackfillMode = "dry-run";
  let connectionString = process.env["TARGET_DATABASE_URL"] ?? "";
  let workosApiKey = process.env["WORKOS_API_KEY"] ?? "";
  let cohortManifestPath = "";
  let confirm = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      mode = "dry-run";
    } else if (arg === "--apply") {
      mode = "apply";
    } else if (arg === "--connection-string" && args[i + 1]) {
      connectionString = args[++i];
    } else if (arg === "--cohort-manifest" && args[i + 1]) {
      cohortManifestPath = args[++i];
    } else if (arg === "--confirm" && args[i + 1]) {
      confirm = args[++i];
    }
  }

  return { mode, connectionString, workosApiKey, cohortManifestPath, confirm };
}

const { mode, connectionString, workosApiKey, cohortManifestPath, confirm } = parseArgs(
  process.argv,
);

if (!connectionString) {
  console.error("Error: TARGET_DATABASE_URL or --connection-string is required.");
  process.exit(1);
}
if (!cohortManifestPath) {
  console.error("Error: --cohort-manifest is required.");
  process.exit(1);
}
if (mode === "apply" && !workosApiKey) {
  console.error("Error: WORKOS_API_KEY is required with --apply.");
  process.exit(1);
}

const cohort = await loadCohortManifest(cohortManifestPath);
if (mode === "apply" && confirm !== cohort.key) {
  console.error(`Error: --apply requires --confirm ${cohort.key}.`);
  process.exit(1);
}

console.log(`WorkOS backfill target cohort: ${cohort.key}`);
console.log(`Database URL host: ${safeDatabaseTarget(connectionString)}`);

const repository = createPgWorkosBackfillRepository({ connectionString });
const summary = await runWorkosBackfill({
  mode,
  cohort,
  repository,
  workos: workosApiKey ? createSdkBackfillClient(workosApiKey) : undefined,
});

printSummary(summary);

if (summary.warnings.length > 0 || (mode === "apply" && hasParityGaps(summary))) {
  process.exitCode = 2;
}

function createSdkBackfillClient(apiKey: string): WorkosBackfillClient {
  const workos = new WorkOS(apiKey);

  return {
    async getUserByExternalId(externalId) {
      try {
        const user = await workos.userManagement.getUserByExternalId(externalId);
        return { id: user.id, externalId: user.externalId };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async getUser(userId) {
      try {
        const user = await workos.userManagement.getUser(userId);
        return { id: user.id, externalId: user.externalId };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async updateUserExternalId(userId, externalId) {
      await workos.userManagement.updateUser({ userId, externalId });
    },
    async createUser(input) {
      const user = await workos.userManagement.createUser({
        email: input.email,
        name: input.name,
        emailVerified: input.emailVerified,
        externalId: input.externalId,
        metadata: input.metadata,
      });
      return { id: user.id, externalId: user.externalId };
    },
    async getOrganizationByExternalId(externalId) {
      try {
        const organization = await workos.organizations.getOrganizationByExternalId(externalId);
        return { id: organization.id, externalId: organization.externalId };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async getOrganization(organizationId) {
      try {
        const organization = await workos.organizations.getOrganization(organizationId);
        return { id: organization.id, externalId: organization.externalId };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async updateOrganizationExternalId(organizationId, externalId) {
      await workos.organizations.updateOrganization({
        organization: organizationId,
        externalId,
      });
    },
    async createOrganization(input) {
      const organization = await workos.organizations.createOrganization(
        {
          name: input.name,
          externalId: input.externalId,
          metadata: input.metadata,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return { id: organization.id, externalId: organization.externalId };
    },
    async createOrganizationMembership(input) {
      const membership = await workos.userManagement.createOrganizationMembership({
        userId: input.userId,
        organizationId: input.organizationId,
        roleSlugs: input.roleSlugs,
      });
      return {
        id: membership.id,
        roleSlugs: membershipRoleSlugs(membership, input.roleSlugs),
        status: membership.status,
      };
    },
    async getOrganizationMembership(membershipId) {
      try {
        const membership = await workos.userManagement.getOrganizationMembership(membershipId);
        return {
          id: membership.id,
          userId: membership.userId,
          organizationId: membership.organizationId,
          roleSlugs: membershipRoleSlugs(membership),
          status: membership.status,
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async updateOrganizationMembershipRoles(membershipId, roleSlugs) {
      const membership = await workos.userManagement.updateOrganizationMembership(membershipId, {
        roleSlugs,
      });
      return {
        id: membership.id,
        roleSlugs: membershipRoleSlugs(membership, roleSlugs),
        status: membership.status,
      };
    },
    async findOrganizationMembership(input) {
      const memberships = await workos.userManagement.listOrganizationMemberships({
        userId: input.userId,
        organizationId: input.organizationId,
        statuses: ["active", "inactive"],
        limit: 1,
      });
      const membership = memberships.data[0];
      if (!membership) return null;
      return {
        id: membership.id,
        roleSlugs: membershipRoleSlugs(membership),
        status: membership.status,
      };
    },
  };
}

function membershipRoleSlugs(
  membership: { roles?: Array<{ slug: string }>; role?: { slug: string } },
  fallback: string[] = [],
): string[] {
  const roleSlugs = membership.roles?.map((role) => role.slug).filter(Boolean) ?? [];
  if (roleSlugs.length > 0) return roleSlugs;
  if (membership.role?.slug) return [membership.role.slug];
  return fallback;
}

function hasParityGaps(summary: WorkosBackfillSummary): boolean {
  return (
    summary.parity.missingLocalUserLinks > 0 ||
    summary.parity.missingLocalOrganizationLinks > 0 ||
    summary.parity.duplicateLocalOrganizationLinks > 0 ||
    summary.parity.missingLocalMembershipLinks > 0 ||
    summary.parity.staleLocalMembershipLinks > 0 ||
    summary.parity.membershipRoleMismatches > 0
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}

function printSummary(summary: WorkosBackfillSummary): void {
  console.log(`WorkOS backfill ${summary.mode} summary for ${summary.cohortKey}`);
  console.log(`Users:         ${formatCounter(summary.users)}`);
  console.log(`Organizations: ${formatCounter(summary.organizations)}`);
  console.log(`Memberships:   ${formatCounter(summary.memberships)}`);
  console.log(
    `Parity missing links: users=${summary.parity.missingLocalUserLinks}, ` +
      `organizations=${summary.parity.missingLocalOrganizationLinks}, ` +
      `duplicateOrganizations=${summary.parity.duplicateLocalOrganizationLinks}, ` +
      `memberships=${summary.parity.missingLocalMembershipLinks}, ` +
      `staleMemberships=${summary.parity.staleLocalMembershipLinks}, ` +
      `membershipRoleMismatches=${summary.parity.membershipRoleMismatches}`,
  );
  if (summary.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of summary.warnings) {
      console.log(`- ${warning}`);
    }
  }
}

function formatCounter(counter: WorkosBackfillSummary["users"]): string {
  return (
    `planned=${counter.planned}, created=${counter.created}, ` +
    `linkedExisting=${counter.linkedExisting}, skipped=${counter.skipped}, conflicts=${counter.conflicts}`
  );
}

async function loadCohortManifest(path: string): Promise<WorkosBackfillCohort> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Cohort manifest must be a JSON object.");
  }
  const manifest = parsed as Partial<WorkosBackfillCohort>;
  return {
    key: requireString(manifest.key, "key"),
    userIds: requireStringArray(manifest.userIds, "userIds"),
    organizationIds: requireStringArray(manifest.organizationIds, "organizationIds"),
    membershipIds: optionalStringArray(manifest.membershipIds, "membershipIds"),
  };
}

function requireString(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Cohort manifest ${key} must be a non-empty string.`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`Cohort manifest ${key} must be a non-empty string array.`);
  }
  return value;
}

function optionalStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`Cohort manifest ${key} must be a string array when provided.`);
  }
  return value;
}

function safeDatabaseTarget(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.hostname}/${url.pathname.replace(/^\//, "")}`;
}
