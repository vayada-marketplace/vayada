import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ access: vi.fn(), admins: vi.fn(), start: vi.fn() }));
vi.mock("@/services/api/pmsStaffClient", async (original) => ({
  ...(await original<object>()),
  getPmsStaffAccess: api.access,
  getPmsAccountAdmins: api.admins,
}));
vi.mock("@/services/auth/adminTransfer", () => ({ startAdminTransfer: api.start }));
vi.mock("@/components/Modal", () => ({
  default: ({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));

import AdminTransferDialog from "./AdminTransferDialog";

beforeEach(() => {
  vi.clearAllMocks();
  api.access.mockImplementation(async (id: string) => ({
    revision: "b".repeat(64),
  }));
  api.admins.mockResolvedValue({
    actorMembershipId: "actor",
    admins: [
      {
        membershipId: "actor",
        roleKey: "hotel_owner",
        active: true,
        revision: "a".repeat(64),
      },
    ],
  });
  api.start.mockResolvedValue(undefined);
});

it("captures fresh actor and target revisions before starting verification", async () => {
  const view = create(
    <AdminTransferDialog
      actorMembershipId="actor"
      members={[
        {
          id: "actor",
          name: "Current owner",
          email: "owner@example.test",
          roleKey: "hotel_manager",
          propertyIds: [],
          status: "active",
          lastActiveAt: null,
        },
        {
          id: "target",
          name: "New owner",
          email: "new@example.test",
          roleKey: "front_desk",
          propertyIds: [],
          status: "active",
          lastActiveAt: null,
        },
      ]}
      roles={[
        {
          id: "role",
          name: "Agency manager",
          description: "",
          revision: "7",
          securityClass: "staff",
          baseRoleKey: "hotel_manager",
          presetKey: "agency_manager",
          defaultPermissions: [],
          allowedPermissions: [],
          immutable: false,
          memberCount: 0,
          invitationCount: 0,
        },
      ]}
      onClose={vi.fn()}
    />,
  );
  await act(async () => {
    view.root.findAllByType("select")[0]!.props.onChange({ target: { value: "target" } });
  });
  await act(async () => {
    await view.root
      .findAllByType("button")
      .find((button) => button.children.includes("Continue to verification"))!
      .props.onClick();
  });

  expect(api.admins).toHaveBeenCalledOnce();
  expect(api.access.mock.calls).toEqual([["target"]]);
  expect(api.start).toHaveBeenCalledWith({
    targetMembershipId: "target",
    expectedActorRevision: "a".repeat(64),
    expectedTargetRevision: "b".repeat(64),
    formerAdmin: {
      roleDefinitionId: "role",
      expectedRoleRevision: "7",
      propertyAccessMode: "all",
      propertyIds: [],
      permissionOverrides: { grant: [], deny: [] },
      productAccess: { pms: true, booking: true },
    },
  });
  view.unmount();
});
