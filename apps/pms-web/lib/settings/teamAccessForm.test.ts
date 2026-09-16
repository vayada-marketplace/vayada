import { describe, expect, it } from "vitest";
import { assignableTeamRoles, initialTeamAccess, teamAccessConfiguration } from "./teamAccessForm";
import type { PmsStaffAccess, PmsTeamRole } from "@/services/api/pmsStaffClient";

const role: PmsTeamRole = {
  id: "role",
  name: "Reception",
  description: "",
  revision: "4",
  securityClass: "staff",
  baseRoleKey: "front_desk",
  presetKey: "front_desk",
  defaultPermissions: ["pms.calendar.read"],
  allowedPermissions: ["pms.calendar.read", "pms.calendar.manage"],
  immutable: false,
  memberCount: 1,
  invitationCount: 0,
};
const access: PmsStaffAccess = {
  membershipId: "member",
  roleKey: "front_desk",
  status: "active",
  revision: "7",
  roleDefinitionId: role.id,
  roleDefinition: role,
  configuredPermissions: ["pms.calendar.read"],
  propertyAccessMode: "assigned",
  propertyIds: ["property"],
  productAccess: { pms: true, booking: false },
  permissionOverrides: { grant: ["pms.calendar.read"], deny: ["pms.calendar.manage"] },
};
describe("team access form commands", () => {
  it("preserves explicit overrides and the opened role revision when changing product or property access", () => {
    const draft = initialTeamAccess(access);
    draft.productAccess.pms = false;
    draft.propertyAccessMode = "all";
    const output = teamAccessConfiguration(draft, [{ ...role, revision: "5" }], access);
    expect(output).toMatchObject({
      permissionOverrides: access.permissionOverrides,
      expectedRoleRevision: "4",
      propertyIds: [],
      productAccess: { pms: false, booking: false },
    });
    expect(access.productAccess.pms).toBe(true);
  });
  it("changes only edited permission overrides", () => {
    const draft = initialTeamAccess(access);
    draft.permissions.push("pms.calendar.manage");
    expect(teamAccessConfiguration(draft, [role], access).permissionOverrides).toEqual({
      grant: ["pms.calendar.read", "pms.calendar.manage"],
      deny: [],
    });
    draft.permissions = [];
    expect(teamAccessConfiguration(draft, [role], access).permissionOverrides).toEqual({
      grant: [],
      deny: ["pms.calendar.manage", "pms.calendar.read"],
    });
  });
  it("clears explicit overrides only after an intentional reset", () => {
    const draft = initialTeamAccess(access);
    draft.resetOverrides = true;
    expect(teamAccessConfiguration(draft, [role], access).permissionOverrides).toEqual({
      grant: [],
      deny: [],
    });
  });
  it("keeps legacy members unassigned to a saved role", () => {
    const legacy = { ...access, roleDefinitionId: null, roleDefinition: null };
    const output = teamAccessConfiguration(initialTeamAccess(legacy), [role], legacy);
    expect(output).not.toHaveProperty("roleDefinitionId");
    expect(output.permissionOverrides).toEqual(access.permissionOverrides);
  });
  it("requires explicit reset acknowledgment when changing a member role", () => {
    const next = { ...role, id: "next" };
    const draft = { ...initialTeamAccess(access), roleId: next.id };
    expect(() => teamAccessConfiguration(draft, [next], access)).toThrow(/Confirm/);
    expect(
      teamAccessConfiguration({ ...draft, resetOverrides: true }, [next], access)
        .permissionOverrides,
    ).toEqual({ grant: [], deny: [] });
  });
  it("rejects lost saved roles and all-property external owners", () => {
    expect(() => teamAccessConfiguration(initialTeamAccess(access), [], access)).toThrow();
    const owner = {
      ...role,
      baseRoleKey: "external_owner",
      securityClass: "external_owner",
    } as PmsTeamRole;
    expect(() =>
      teamAccessConfiguration(
        { ...initialTeamAccess(), roleId: owner.id, propertyAccessMode: "all" },
        [owner],
      ),
    ).toThrow();
  });
  it("excludes protected roles from manager choices", () => {
    const roles: PmsTeamRole[] = [
      role,
      { ...role, id: "admin", securityClass: "account_admin", baseRoleKey: "hotel_owner" },
      { ...role, id: "manager", baseRoleKey: "hotel_manager", presetKey: "agency_manager" },
      { ...role, id: "owner", securityClass: "external_owner", baseRoleKey: "external_owner" },
      { ...role, id: "managing-worker", defaultPermissions: ["identity.staff.manage"] },
    ];
    expect(assignableTeamRoles(roles, false).map((item) => item.id)).toEqual(["role"]);
    expect(assignableTeamRoles(roles, true)).toHaveLength(4);
    expect(
      assignableTeamRoles([{ ...role, baseRoleKey: "hotel_manager", presetKey: null }], false),
    ).toHaveLength(1);
  });
});
