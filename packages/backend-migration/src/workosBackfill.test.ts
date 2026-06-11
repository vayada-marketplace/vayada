import { describe, expect, it } from "vitest";

import {
  runWorkosBackfill,
  type WorkosBackfillClient,
  type WorkosBackfillRepository,
  type WorkosBackfillSource,
} from "./workosBackfill.js";

describe("runWorkosBackfill", () => {
  it("summarizes dry-run work without calling WorkOS or writing local links", async () => {
    const repository = createMemoryRepository({
      users: [user()],
      organizations: [organization()],
      memberships: [membership()],
    });

    const summary = await runWorkosBackfill({
      mode: "dry-run",
      cohort: defaultCohort(),
      repository,
    });

    expect(summary.users).toMatchObject({ planned: 1, created: 0, linkedExisting: 0, skipped: 0 });
    expect(summary.organizations).toMatchObject({
      planned: 1,
      created: 0,
      linkedExisting: 0,
      skipped: 0,
    });
    expect(summary.memberships).toMatchObject({
      planned: 1,
      created: 0,
      linkedExisting: 0,
      skipped: 0,
    });
    expect(summary.parity).toEqual({
      missingLocalUserLinks: 1,
      missingLocalOrganizationLinks: 1,
      duplicateLocalOrganizationLinks: 0,
      missingLocalMembershipLinks: 1,
      staleLocalMembershipLinks: 0,
      membershipRoleMismatches: 0,
    });
    expect(repository.linkedUsers).toEqual([]);
  });

  it("creates missing WorkOS users, organizations, and active memberships", async () => {
    const repository = createMemoryRepository({
      users: [user()],
      organizations: [organization()],
      memberships: [membership()],
    });
    const workos = createMemoryWorkosClient();

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(summary.users.created).toBe(1);
    expect(summary.organizations.created).toBe(1);
    expect(summary.memberships.created).toBe(1);
    expect(repository.linkedUsers).toEqual([
      expect.objectContaining({
        userId: "user_internal",
        workosUserId: "user_workos_created_1",
      }),
    ]);
    expect(repository.linkedOrganizations).toEqual([
      expect.objectContaining({
        organizationId: "org_internal",
        workosOrgId: "org_workos_created_1",
        workosExternalId: "org_internal",
      }),
    ]);
    expect(repository.linkedMemberships).toEqual([
      expect.objectContaining({
        membershipId: "membership_internal",
        workosMembershipId: "om_workos_created_1",
        roleSlugs: ["hotel_owner"],
      }),
    ]);
    expect(summary.parity).toEqual({
      missingLocalUserLinks: 0,
      missingLocalOrganizationLinks: 0,
      duplicateLocalOrganizationLinks: 0,
      missingLocalMembershipLinks: 0,
      staleLocalMembershipLinks: 0,
      membershipRoleMismatches: 0,
    });
  });

  it("links existing WorkOS resources by external ID before creating memberships", async () => {
    const repository = createMemoryRepository({
      users: [user()],
      organizations: [organization()],
      memberships: [membership({ workosRoleSlugs: ["hotel_owner", "booking_manager"] })],
    });
    const workos = createMemoryWorkosClient({
      existingUsersByExternalId: new Map([["user_internal", "user_workos_existing"]]),
      existingOrganizationsByExternalId: new Map([["org_internal", "org_workos_existing"]]),
    });

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(summary.users).toMatchObject({ created: 0, linkedExisting: 1, skipped: 0 });
    expect(summary.organizations).toMatchObject({ created: 0, linkedExisting: 1, skipped: 0 });
    expect(workos.createdUsers).toEqual([]);
    expect(workos.createdOrganizations).toEqual([]);
    expect(workos.createdMemberships).toEqual([
      {
        userId: "user_workos_existing",
        organizationId: "org_workos_existing",
        roleSlugs: ["hotel_owner"],
      },
    ]);
  });

  it("links an existing WorkOS membership before creating a duplicate", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "user_workos_existing" })],
      organizations: [organization({ workosOrgId: "org_workos_existing" })],
      memberships: [membership()],
    });
    const workos = createMemoryWorkosClient({
      existingMembershipsByUserOrg: new Map([
        [
          "user_workos_existing:org_workos_existing",
          { id: "om_workos_existing", status: "active", roleSlugs: [] },
        ],
      ]),
    });

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(summary.memberships).toMatchObject({ created: 0, linkedExisting: 1, skipped: 0 });
    expect(workos.createdMemberships).toEqual([]);
    expect(workos.updatedMemberships).toEqual([
      { membershipId: "om_workos_existing", roleSlugs: ["hotel_owner"] },
    ]);
    expect(repository.linkedMemberships).toEqual([
      expect.objectContaining({
        membershipId: "membership_internal",
        workosMembershipId: "om_workos_existing",
      }),
    ]);
  });

  it("reactivates existing inactive WorkOS memberships instead of treating them as linked", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "user_workos_existing" })],
      organizations: [organization({ workosOrgId: "org_workos_existing" })],
      memberships: [membership()],
    });
    const workos = createMemoryWorkosClient({
      existingMembershipsByUserOrg: new Map([
        [
          "user_workos_existing:org_workos_existing",
          { id: "om_workos_inactive", status: "inactive", roleSlugs: [] },
        ],
      ]),
    });

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(summary.memberships).toMatchObject({ created: 0, linkedExisting: 1, skipped: 0 });
    expect(workos.createdMemberships).toEqual([
      {
        userId: "user_workos_existing",
        organizationId: "org_workos_existing",
        roleSlugs: ["hotel_owner"],
      },
    ]);
    expect(repository.linkedMemberships).toEqual([
      expect.objectContaining({
        membershipId: "membership_internal",
        workosMembershipId: "om_workos_inactive",
      }),
    ]);
  });

  it("repairs missing local organization external id for existing WorkOS links", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "user_workos_existing" })],
      organizations: [organization({ workosOrgId: "org_workos_existing" })],
      memberships: [
        membership({ workosMembershipId: "om_existing", workosRoleSlugs: ["hotel_owner"] }),
      ],
    });
    const workos = createMemoryWorkosClient({
      usersById: new Map([["user_workos_existing", { externalId: "user_internal" }]]),
      organizationsById: new Map([["org_workos_existing", { externalId: "org_internal" }]]),
    });

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(repository.linkedOrganizations).toEqual([
      expect.objectContaining({
        organizationId: "org_internal",
        workosOrgId: "org_workos_existing",
        workosExternalId: "org_internal",
      }),
    ]);
    expect(summary.parity).toEqual({
      missingLocalUserLinks: 0,
      missingLocalOrganizationLinks: 0,
      duplicateLocalOrganizationLinks: 0,
      missingLocalMembershipLinks: 0,
      staleLocalMembershipLinks: 0,
      membershipRoleMismatches: 0,
    });
  });

  it("keeps parity incomplete when a user has duplicate local WorkOS identity rows", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "user_workos_existing", workosIdentityCount: 2 })],
      organizations: [
        organization({
          workosOrgId: "org_workos_existing",
          workosExternalId: "org_internal",
        }),
      ],
      memberships: [
        membership({ workosMembershipId: "om_existing", workosRoleSlugs: ["hotel_owner"] }),
      ],
    });

    const summary = await runWorkosBackfill({
      mode: "dry-run",
      cohort: defaultCohort(),
      repository,
    });

    expect(summary.parity).toEqual({
      missingLocalUserLinks: 1,
      missingLocalOrganizationLinks: 0,
      duplicateLocalOrganizationLinks: 0,
      missingLocalMembershipLinks: 0,
      staleLocalMembershipLinks: 0,
      membershipRoleMismatches: 0,
    });
  });

  it("keeps parity incomplete when cohort organizations share a WorkOS organization id", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "user_workos_existing" })],
      organizations: [
        organization({
          workosOrgId: "org_workos_duplicate",
          workosExternalId: "org_internal",
        }),
        organization({
          id: "org_second",
          name: "Second Organization",
          workosOrgId: "org_workos_duplicate",
          workosExternalId: "org_second",
        }),
      ],
      memberships: [
        membership({ workosMembershipId: "om_existing", workosRoleSlugs: ["hotel_owner"] }),
      ],
    });

    const summary = await runWorkosBackfill({
      mode: "dry-run",
      cohort: {
        key: "duplicate-orgs",
        userIds: ["user_internal"],
        organizationIds: ["org_internal", "org_second"],
      },
      repository,
    });

    expect(summary.parity).toEqual({
      missingLocalUserLinks: 0,
      missingLocalOrganizationLinks: 0,
      duplicateLocalOrganizationLinks: 2,
      missingLocalMembershipLinks: 0,
      staleLocalMembershipLinks: 0,
      membershipRoleMismatches: 0,
    });
  });

  it("updates role mismatches on existing WorkOS memberships", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "user_workos_existing" })],
      organizations: [
        organization({
          workosOrgId: "org_workos_existing",
          workosExternalId: "org_internal",
        }),
      ],
      memberships: [
        membership({
          workosMembershipId: "om_workos_existing",
          workosRoleSlugs: ["viewer"],
        }),
      ],
    });
    const workos = createMemoryWorkosClient({
      existingMembershipsByUserOrg: new Map([
        [
          "user_workos_existing:org_workos_existing",
          { id: "om_workos_existing", status: "active", roleSlugs: ["viewer"] },
        ],
      ]),
    });

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(workos.updatedMemberships).toEqual([
      { membershipId: "om_workos_existing", roleSlugs: ["hotel_owner"] },
    ]);
    expect(repository.linkedMemberships).toEqual([
      expect.objectContaining({
        membershipId: "membership_internal",
        workosMembershipId: "om_workos_existing",
        roleSlugs: ["hotel_owner"],
      }),
    ]);
    expect(summary.parity).toEqual({
      missingLocalUserLinks: 0,
      missingLocalOrganizationLinks: 0,
      duplicateLocalOrganizationLinks: 0,
      missingLocalMembershipLinks: 0,
      staleLocalMembershipLinks: 0,
      membershipRoleMismatches: 0,
    });
  });

  it("reports stale local WorkOS membership links with the wrong user or organization", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "user_workos_existing" })],
      organizations: [
        organization({
          workosOrgId: "org_workos_existing",
          workosExternalId: "org_internal",
        }),
      ],
      memberships: [membership({ workosMembershipId: "om_wrong" })],
    });
    const workos = createMemoryWorkosClient({
      existingMembershipsById: new Map([
        [
          "om_wrong",
          {
            id: "om_wrong",
            userId: "user_other",
            organizationId: "org_workos_existing",
            status: "active",
            roleSlugs: ["hotel_owner"],
          },
        ],
      ]),
    });

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(summary.memberships.conflicts).toBe(1);
    expect(summary.parity.staleLocalMembershipLinks).toBe(1);
    expect(repository.linkedMemberships).toEqual([]);
  });

  it("only backfills rows in the selected cohort", async () => {
    const repository = createMemoryRepository({
      users: [user(), user({ id: "user_outside", email: "outside@example.com" })],
      organizations: [organization(), organization({ id: "org_outside", name: "Outside" })],
      memberships: [
        membership(),
        membership({
          id: "membership_outside",
          userId: "user_outside",
          organizationId: "org_outside",
        }),
      ],
    });

    const summary = await runWorkosBackfill({
      mode: "dry-run",
      cohort: defaultCohort(),
      repository,
    });

    expect(summary.users.planned).toBe(1);
    expect(summary.organizations.planned).toBe(1);
    expect(summary.memberships.planned).toBe(1);
  });

  it("reports conflicts for existing WorkOS links with mismatched external ids", async () => {
    const repository = createMemoryRepository({
      users: [user({ workosUserId: "user_workos_existing" })],
      organizations: [
        organization({
          workosOrgId: "org_workos_existing",
          workosExternalId: "different_org",
        }),
      ],
      memberships: [membership()],
    });
    const workos = createMemoryWorkosClient({
      usersById: new Map([["user_workos_existing", { externalId: "different_user" }]]),
      organizationsById: new Map([["org_workos_existing", { externalId: "org_internal" }]]),
    });

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(summary.users.conflicts).toBe(1);
    expect(summary.organizations.conflicts).toBe(1);
    expect(summary.memberships.skipped).toBe(1);
    expect(repository.linkedUsers).toEqual([]);
    expect(repository.linkedOrganizations).toEqual([]);
  });

  it("skips deleted users, archived organizations, and non-active memberships", async () => {
    const repository = createMemoryRepository({
      users: [user({ status: "deleted" })],
      organizations: [organization({ status: "archived" })],
      memberships: [membership({ status: "suspended" })],
    });
    const workos = createMemoryWorkosClient();

    const summary = await runWorkosBackfill({
      mode: "apply",
      cohort: defaultCohort(),
      repository,
      workos,
    });

    expect(summary.users.skipped).toBe(1);
    expect(summary.organizations.skipped).toBe(1);
    expect(summary.memberships.skipped).toBe(1);
    expect(summary.warnings).toEqual([
      "Skipped deleted user user_internal",
      "Skipped archived organization org_internal",
      "Skipped non-active membership membership_internal",
    ]);
    expect(workos.createdUsers).toEqual([]);
    expect(workos.createdOrganizations).toEqual([]);
    expect(workos.createdMemberships).toEqual([]);
    expect(summary.parity).toEqual({
      missingLocalUserLinks: 0,
      missingLocalOrganizationLinks: 0,
      duplicateLocalOrganizationLinks: 0,
      missingLocalMembershipLinks: 0,
      staleLocalMembershipLinks: 0,
      membershipRoleMismatches: 0,
    });
  });
});

function user(overrides: Partial<WorkosBackfillSource["users"][number]> = {}) {
  const base = {
    id: "user_internal",
    email: "owner@example.com",
    name: "Owner",
    status: "active",
    emailVerified: true,
    workosUserId: null,
    workosIdentityCount: 0,
    ...overrides,
  };
  if (overrides.workosUserId && overrides.workosIdentityCount === undefined) {
    base.workosIdentityCount = 1;
  }
  return base;
}

function organization(overrides: Partial<WorkosBackfillSource["organizations"][number]> = {}) {
  return {
    id: "org_internal",
    kind: "hotel_group",
    name: "Hotel Group",
    slug: "hotel-group",
    status: "active",
    workosOrgId: null,
    workosExternalId: null,
    ...overrides,
  };
}

function membership(overrides: Partial<WorkosBackfillSource["memberships"][number]> = {}) {
  return {
    id: "membership_internal",
    userId: "user_internal",
    organizationId: "org_internal",
    status: "active",
    roleKey: "hotel_owner",
    workosMembershipId: null,
    workosRoleSlugs: [],
    ...overrides,
  };
}

function defaultCohort() {
  return {
    key: "test-cohort",
    userIds: ["user_internal"],
    organizationIds: ["org_internal"],
  };
}

function createMemoryRepository(source: WorkosBackfillSource) {
  const linkedUsers: Array<Parameters<WorkosBackfillRepository["linkUser"]>[0]> = [];
  const linkedOrganizations: Array<Parameters<WorkosBackfillRepository["linkOrganization"]>[0]> =
    [];
  const linkedMemberships: Array<Parameters<WorkosBackfillRepository["linkMembership"]>[0]> = [];

  const repository: WorkosBackfillRepository & {
    linkedUsers: typeof linkedUsers;
    linkedOrganizations: typeof linkedOrganizations;
    linkedMemberships: typeof linkedMemberships;
  } = {
    linkedUsers,
    linkedOrganizations,
    linkedMemberships,
    async loadSource() {
      return source;
    },
    async linkUser(input) {
      linkedUsers.push(input);
      const sourceUser = source.users.find((candidate) => candidate.id === input.userId);
      if (sourceUser) {
        sourceUser.workosUserId = input.workosUserId;
        sourceUser.workosIdentityCount = 1;
      }
    },
    async linkOrganization(input) {
      linkedOrganizations.push(input);
      const sourceOrganization = source.organizations.find(
        (candidate) => candidate.id === input.organizationId,
      );
      if (sourceOrganization) {
        sourceOrganization.workosOrgId = input.workosOrgId;
        sourceOrganization.workosExternalId = input.workosExternalId;
      }
    },
    async linkMembership(input) {
      linkedMemberships.push(input);
      const sourceMembership = source.memberships.find(
        (candidate) => candidate.id === input.membershipId,
      );
      if (sourceMembership) {
        sourceMembership.workosMembershipId = input.workosMembershipId;
        sourceMembership.workosRoleSlugs = input.roleSlugs;
      }
    },
  };

  return repository;
}

function createMemoryWorkosClient(
  config: {
    existingUsersByExternalId?: Map<string, string>;
    existingOrganizationsByExternalId?: Map<string, string>;
    existingMembershipsByUserOrg?: Map<string, { id: string; status: string; roleSlugs: string[] }>;
    existingMembershipsById?: Map<
      string,
      {
        id: string;
        userId: string;
        organizationId: string;
        status: string;
        roleSlugs: string[];
      }
    >;
    usersById?: Map<string, { externalId: string | null }>;
    organizationsById?: Map<string, { externalId: string | null }>;
  } = {},
) {
  const createdUsers: Array<{ email: string; externalId: string }> = [];
  const createdOrganizations: Array<{ name: string; externalId: string }> = [];
  const createdMemberships: Array<{ userId: string; organizationId: string; roleSlugs: string[] }> =
    [];
  const updatedMemberships: Array<{ membershipId: string; roleSlugs: string[] }> = [];

  const workos: WorkosBackfillClient & {
    createdUsers: typeof createdUsers;
    createdOrganizations: typeof createdOrganizations;
    createdMemberships: typeof createdMemberships;
    updatedMemberships: typeof updatedMemberships;
  } = {
    createdUsers,
    createdOrganizations,
    createdMemberships,
    updatedMemberships,
    async getUserByExternalId(externalId) {
      const id = config.existingUsersByExternalId?.get(externalId);
      return id ? { id, externalId } : null;
    },
    async getUser(userId) {
      const user = config.usersById?.get(userId);
      if (user) return { id: userId, externalId: user.externalId };
      if (userId.startsWith("user_workos")) return { id: userId, externalId: "user_internal" };
      return null;
    },
    async updateUserExternalId() {},
    async getOrganization(organizationId) {
      const organization = config.organizationsById?.get(organizationId);
      if (organization) return { id: organizationId, externalId: organization.externalId };
      if (organizationId.startsWith("org_workos")) {
        return { id: organizationId, externalId: "org_internal" };
      }
      return null;
    },
    async createUser(input) {
      createdUsers.push({ email: input.email, externalId: input.externalId });
      return { id: `user_workos_created_${createdUsers.length}`, externalId: input.externalId };
    },
    async getOrganizationByExternalId(externalId) {
      const id = config.existingOrganizationsByExternalId?.get(externalId);
      return id ? { id, externalId } : null;
    },
    async updateOrganizationExternalId() {},
    async createOrganization(input) {
      createdOrganizations.push({ name: input.name, externalId: input.externalId });
      return {
        id: `org_workos_created_${createdOrganizations.length}`,
        externalId: input.externalId,
      };
    },
    async createOrganizationMembership(input) {
      createdMemberships.push(input);
      const existing = config.existingMembershipsByUserOrg?.get(
        `${input.userId}:${input.organizationId}`,
      );
      if (existing?.status === "inactive") {
        existing.status = "active";
        existing.roleSlugs = input.roleSlugs;
        return {
          id: existing.id,
          roleSlugs: input.roleSlugs,
          status: "active",
        };
      }
      return {
        id: `om_workos_created_${createdMemberships.length}`,
        roleSlugs: input.roleSlugs,
        status: "active",
      };
    },
    async getOrganizationMembership(membershipId) {
      const byId = config.existingMembershipsById?.get(membershipId);
      if (byId) return byId;
      for (const [key, membership] of config.existingMembershipsByUserOrg ?? new Map()) {
        if (membership.id !== membershipId) continue;
        const [userId, organizationId] = key.split(":");
        return {
          id: membership.id,
          userId,
          organizationId,
          roleSlugs: membership.roleSlugs,
          status: membership.status,
        };
      }
      if (membershipId.startsWith("om_")) {
        return {
          id: membershipId,
          userId: "user_workos_existing",
          organizationId: "org_workos_existing",
          roleSlugs: ["hotel_owner"],
          status: "active",
        };
      }
      return null;
    },
    async updateOrganizationMembershipRoles(membershipId, roleSlugs) {
      updatedMemberships.push({ membershipId, roleSlugs });
      for (const membership of config.existingMembershipsByUserOrg?.values() ?? []) {
        if (membership.id === membershipId) membership.roleSlugs = roleSlugs;
      }
      return { id: membershipId, roleSlugs, status: "active" };
    },
    async findOrganizationMembership(input) {
      const membership = config.existingMembershipsByUserOrg?.get(
        `${input.userId}:${input.organizationId}`,
      );
      return membership
        ? { id: membership.id, roleSlugs: membership.roleSlugs, status: membership.status }
        : null;
    },
  };

  return workos;
}
