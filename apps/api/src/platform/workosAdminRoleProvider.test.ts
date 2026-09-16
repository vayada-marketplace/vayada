import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkOSAdminRoleProvider } from "./workosAdminRoleProvider.js";
const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), constructor: vi.fn() }));
vi.mock("@workos-inc/node", async (original) => {
  const sdk = await original<typeof import("@workos-inc/node")>();
  return {
    ...sdk,
    WorkOS: class {
      constructor(...args: unknown[]) {
        mocks.constructor(...args);
      }
      userManagement = {
        getOrganizationMembership: mocks.get,
        updateOrganizationMembership: mocks.update,
      };
    },
  };
});
const input = {
  membershipId: "membership",
  organizationId: "organization",
  userId: "user",
  roleSlug: "hotel_member" as const,
};
const member = {
  id: input.membershipId,
  organizationId: input.organizationId,
  userId: input.userId,
  status: "active",
  role: { slug: "hotel_member" },
  roles: [{ slug: "hotel_member" }],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(member);
  mocks.update.mockResolvedValue(member);
});
describe("WorkOS admin role provider", () => {
  it("checks remote identity and updates only the role with bounded requests", async () => {
    expect(await createWorkOSAdminRoleProvider("test").updateRole(input)).toBe("updated");
    expect(mocks.constructor).toHaveBeenCalledWith("test", { maxRetries: 0, timeout: 10000 });
    expect(mocks.update).toHaveBeenCalledWith("membership", { roleSlug: "hotel_member" });
  });
  it("rejects foreign remote identities before any update", async () => {
    for (const patch of [{ organizationId: "foreign" }, { userId: "foreign" }]) {
      mocks.get.mockResolvedValueOnce({ ...member, ...patch });
      expect(await createWorkOSAdminRoleProvider("test").updateRole(input)).toBe(
        "binding_mismatch",
      );
    }
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not reactivate inactive memberships or accept an unconfirmed role", async () => {
    mocks.get.mockResolvedValueOnce({ ...member, status: "inactive" });
    mocks.update.mockResolvedValueOnce({ ...member, status: "inactive" });
    expect(await createWorkOSAdminRoleProvider("test").updateRole(input)).toBe("updated");
    expect(mocks.update).toHaveBeenCalledWith("membership", { roleSlug: "hotel_member" });
    mocks.get.mockResolvedValueOnce({ ...member, status: "inactive" });
    mocks.update.mockResolvedValueOnce(member);
    await expect(createWorkOSAdminRoleProvider("test").updateRole(input)).rejects.toThrow(
      "not confirmed",
    );
    mocks.update.mockResolvedValueOnce({ ...member, roles: [{ slug: "hotel_owner" }] });
    await expect(createWorkOSAdminRoleProvider("test").updateRole(input)).rejects.toThrow(
      "not confirmed",
    );
  });
});
