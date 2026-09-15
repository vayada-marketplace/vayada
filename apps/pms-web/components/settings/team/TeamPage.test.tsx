import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const api = vi.hoisted(() => ({
  roster: vi.fn(),
  admins: vi.fn(),
  roles: vi.fn(),
  properties: vi.fn(),
  access: vi.fn(),
  invitation: vi.fn(),
  invite: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("@/services/api/pmsStaffClient", async (original) => ({
  ...(await original<object>()),
  getPmsStaffRoster: api.roster,
  getPmsAccountAdmins: api.admins,
  getPmsTeamRoles: api.roles,
  getPmsStaffAccess: api.access,
  getPmsStaffInvitation: api.invitation,
  invitePmsStaff: api.invite,
  preparePmsStaffInvitation: api.prepare,
}));
vi.mock("@/services/api/pmsPropertyClient", () => ({ listPmsProperties: api.properties }));
vi.mock("@/components/Modal", () => ({
  default: ({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
import Page from "@/app/(app)/settings/team/page";
import MemberAccessDialog from "./MemberAccessDialog";
import TeamAccessFields from "./TeamAccessFields";
import TeamActionDialog from "./TeamActionDialog";

beforeEach(() => {
  vi.clearAllMocks();
  api.roster.mockResolvedValue([]);
  api.admins.mockResolvedValue({ admins: [], actorMembershipId: "actor" });
  api.roles.mockResolvedValue({ roles: [], canManageRoles: true });
  api.properties.mockResolvedValue([{ id: "property", name: "Sample property" }]);
});
it("keeps invitation creation available with an empty roster", async () => {
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(<Page />);
  });
  const invite = view.root
    .findAllByType("button")
    .find((button) => button.children.includes("Invite teammate"))!;
  await act(async () => {
    invite.props.onClick();
  });
  expect(view.root.findByType(MemberAccessDialog).props.access).toBeUndefined();
  expect(api.invite).not.toHaveBeenCalled();
  view.unmount();
});
it("shows a load error instead of presenting missing properties as an empty scope", async () => {
  api.properties.mockRejectedValueOnce(new Error("Unavailable"));
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(<Page />);
  });
  expect(view.root.findAll((node) => node.props.role === "alert")).toHaveLength(1);
  expect(
    view.root.findAllByType("button").some((button) => button.children.includes("Invite teammate")),
  ).toBe(false);
  view.unmount();
});
it("captures one invitation configuration for resend and reports unconfirmed delivery accurately", async () => {
  api.roster.mockResolvedValue([
    {
      id: "invite",
      name: null,
      email: "test@example.invalid",
      roleKey: "front_desk",
      status: "pending",
      propertyIds: ["property"],
      lastActiveAt: null,
    },
  ]);
  api.invitation.mockResolvedValue({
    id: "invite",
    name: null,
    email: "test@example.invalid",
    roleKey: "front_desk",
    roleDefinitionId: null,
    roleDefinition: null,
    configurationRevision: 3,
    propertyAccessMode: "assigned",
    propertyIds: ["property"],
    productAccess: { pms: true, booking: false },
    permissionOverrides: { grant: [], deny: [] },
  });
  api.invite.mockResolvedValue({ invitationId: "invite", outcome: "created", delivery: "unknown" });
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(<Page />);
  });
  await act(async () => {
    await view.root
      .findAllByType("button")
      .find((button) => button.children.includes("Resend invitation"))!
      .props.onClick();
  });
  expect(api.invite).not.toHaveBeenCalled();
  const action = view.root.findByType(TeamActionDialog).props.action;
  await expect(action.write("stable-key")).resolves.toContain("not yet confirmed");
  expect(api.invitation).toHaveBeenCalledOnce();
  expect(api.invite).toHaveBeenCalledWith(
    expect.objectContaining({
      configurationRevision: 4,
      expectedInvitationId: "invite",
      propertyIds: ["property"],
    }),
    "stable-key",
  );
  view.unmount();
});

it("retains a prepared invitation revision and key through an uncertain write", async () => {
  const role = {
    id: "role",
    name: "Reception",
    description: "",
    revision: "2",
    baseRoleKey: "front_desk" as const,
    securityClass: "staff" as const,
    presetKey: "front_desk",
    defaultPermissions: ["pms.calendar.read"],
    allowedPermissions: ["pms.calendar.read"],
    immutable: false,
    memberCount: 0,
    invitationCount: 0,
  };
  api.prepare.mockResolvedValue({ configurationRevision: 8 });
  api.invite.mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce({
    invitationId: "invite",
    outcome: "idempotent_replay",
    delivery: "unknown",
  });
  const onSaved = vi.fn();
  const view = create(
    <MemberAccessDialog
      roles={[role]}
      properties={[{ id: "property", name: "Sample" }]}
      canManageRoles
      onClose={vi.fn()}
      onSaved={onSaved}
    />,
  );
  await act(async () => {
    view.root
      .findAllByType("input")
      .find((node) => node.props.type === "email")!
      .props.onChange({ target: { value: "test@example.invalid" } });
    const fields = view.root.findByType(TeamAccessFields);
    fields.props.onChange({
      ...fields.props.draft,
      roleId: "role",
      permissions: role.defaultPermissions,
      propertyIds: ["property"],
    });
  });
  await act(async () => {
    view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
  });
  expect(onSaved).not.toHaveBeenCalled();
  await act(async () => {
    view.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() });
  });
  expect(api.prepare).toHaveBeenCalledOnce();
  expect(api.invite.mock.calls[0]).toEqual(api.invite.mock.calls[1]);
  expect(api.invite.mock.calls[0]?.[0].configurationRevision).toBe(8);
  expect(onSaved).toHaveBeenCalledOnce();
  view.unmount();
});

it("rejects mismatched role and member snapshots before opening the access editor", async () => {
  api.roster.mockResolvedValue([
    {
      id: "member",
      name: "Worker",
      email: "test@example.invalid",
      roleKey: "front_desk",
      status: "active",
      propertyIds: ["property"],
      lastActiveAt: null,
    },
  ]);
  api.access.mockResolvedValue({
    roleDefinitionId: "role",
    roleDefinition: { id: "role", revision: "9" },
  });
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(<Page />);
  });
  await act(async () => {
    await view.root
      .findAllByType("button")
      .find((button) => button.children.includes("Edit member access"))!
      .props.onClick();
  });
  expect(api.roles).toHaveBeenCalledTimes(2);
  expect(view.root.findAllByType(MemberAccessDialog)).toHaveLength(0);
  view.unmount();
});
