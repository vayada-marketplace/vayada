"use client";

import { useCallback, useEffect, useState } from "react";
import { SettingsCard, SettingsLayout, SettingsSection } from "@vayada/settings-ui";

import PropertyAccessMatrix from "@/components/settings/team/PropertyAccessMatrix";
import MemberAccessDialog from "@/components/settings/team/MemberAccessDialog";
import RoleEditorDialog from "@/components/settings/team/RoleEditorDialog";
import TeamRoleCards from "@/components/settings/team/TeamRoleCards";
import TeamActionDialog, { type TeamAction } from "@/components/settings/team/TeamActionDialog";
import { getPmsSettingsSections } from "@/lib/settings/navigation";
import { useTranslation } from "@/lib/i18n";
import { listPmsProperties, type PmsPropertySummary } from "@/services/api/pmsPropertyClient";
import {
  getPmsStaffRoster,
  getPmsTeamRoles,
  getPmsStaffAccess,
  getPmsStaffInvitation,
  deletePmsTeamRole,
  removePmsStaff,
  invitePmsStaff,
  pmsStaffResendInput,
  type PmsTeamRole,
  type PmsStaffAccess,
  type PmsInviteResult,
  updatePmsStaffStatus,
  type PmsStaffMember,
} from "@/services/api/pmsStaffClient";

const roleLabelKeys: Record<PmsStaffMember["roleKey"], string> = {
  hotel_manager: "settings.team.roleManager",
  front_desk: "settings.team.roleFrontDesk",
  housekeeping: "settings.team.roleHousekeeping",
  hotel_custom: "settings.team.roleCustom",
  external_owner: "settings.team.roleOwner",
};

export default function TeamSettingsPage() {
  const { t, locale } = useTranslation();
  const sections = getPmsSettingsSections(false, t);
  const [roles, setRoles] = useState<PmsTeamRole[]>([]);
  const [canManageRoles, setCanManageRoles] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [opening, setOpening] = useState(false);
  const [dialog, setDialog] = useState<
    | { kind: "member"; access?: PmsStaffAccess; name?: string }
    | { kind: "role"; role?: PmsTeamRole }
    | { kind: "action"; action: TeamAction }
    | null
  >(null);
  const [members, setMembers] = useState<PmsStaffMember[]>([]);
  const [properties, setProperties] = useState<PmsPropertySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatingMemberId, setUpdatingMemberId] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{
    memberId: string;
    type: "error" | "success";
    message: string;
  } | null>(null);

  const loadRoster = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextMembers, nextProperties, catalog] = await Promise.all([
        getPmsStaffRoster(),
        listPmsProperties(),
        getPmsTeamRoles(),
      ]);
      setRoles(catalog.roles);
      setCanManageRoles(catalog.canManageRoles);
      setMembers(nextMembers);
      setProperties(nextProperties);
    } catch {
      setError(t("settings.team.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  const changeStatus = async (member: PmsStaffMember) => {
    const nextStatus = member.status === "active" ? "deactivated" : "active";
    const label = member.name || member.email;
    if (
      nextStatus === "deactivated" &&
      !window.confirm(t("settings.team.deactivateConfirm", { name: label }))
    ) {
      return;
    }

    setUpdatingMemberId(member.id);
    setActionFeedback(null);
    try {
      const updated = await updatePmsStaffStatus(member.id, nextStatus);
      setMembers((current) =>
        current.map((item) =>
          item.id === updated.membershipId ? { ...item, status: updated.status } : item,
        ),
      );
      setActionFeedback({
        memberId: member.id,
        type: "success",
        message: t(
          updated.status === "active"
            ? "settings.team.reactivatedSuccess"
            : "settings.team.deactivatedSuccess",
          { name: label },
        ),
      });
    } catch {
      setActionFeedback({
        memberId: member.id,
        type: "error",
        message: t("settings.team.updateError", { name: label }),
      });
    } finally {
      setUpdatingMemberId(null);
    }
  };

  const saved = (message: string) => {
    setDialog(null);
    setFeedback(message);
    void loadRoster();
  };
  const invitationMessage = (result: PmsInviteResult) =>
    t(
      result.delivery === "delivered"
        ? "settings.team.invitationSent"
        : "settings.team.invitationDeliveryPending",
    );
  async function openMember(member: PmsStaffMember) {
    setOpening(true);
    setFeedback("");
    try {
      if (member.status === "pending") {
        const input = pmsStaffResendInput(await getPmsStaffInvitation(member.id));
        setDialog({
          kind: "action",
          action: {
            title: t("settings.team.resendInvitation"),
            description: t("settings.team.resendConfirm", { email: member.email }),
            write: async (key) => invitationMessage(await invitePmsStaff(input, key)),
          },
        });
      } else {
        const [access, catalog] = await Promise.all([
          getPmsStaffAccess(member.id),
          getPmsTeamRoles(),
        ]);
        if (
          access.roleDefinitionId &&
          catalog.roles.find((role) => role.id === access.roleDefinitionId)?.revision !==
            access.roleDefinition?.revision
        )
          throw new Error("Role changed while opening member access");
        setRoles(catalog.roles);
        setCanManageRoles(catalog.canManageRoles);
        setDialog({
          kind: "member",
          access,
          name: member.name || member.email,
        });
      }
    } catch {
      setFeedback(t("settings.team.loadError"));
    } finally {
      setOpening(false);
    }
  }
  const propertyNames = new Map(properties.map((property) => [property.id, property.name]));

  return (
    <SettingsLayout title={t("settings.title")} sections={sections} activeId="team">
      <SettingsSection
        id="team"
        title={t("settings.team.pageTitle")}
        description={t("settings.team.description")}
      >
        {feedback && (
          <p role="status" className="rounded-lg border border-gray-200 bg-white p-3 text-sm">
            {feedback}
          </p>
        )}
        {!loading && !error && (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-gray-500">
              {t("settings.team.summary", {
                active: members.filter((member) => member.status === "active").length,
                invited: members.filter((member) => member.status === "pending").length,
                suspended: members.filter((member) => member.status === "deactivated").length,
                properties: properties.length,
              })}
            </p>
            <button
              type="button"
              disabled={opening}
              onClick={() => setDialog({ kind: "member" })}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white"
            >
              {t("settings.team.inviteTeammate")}
            </button>
          </div>
        )}
        {loading ? (
          <SettingsCard>
            <p role="status" className="text-sm text-gray-500">
              {t("settings.team.loading")}
            </p>
          </SettingsCard>
        ) : error ? (
          <SettingsCard>
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-red-600">{error}</p>
              <button
                type="button"
                onClick={() => void loadRoster()}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
              >
                {t("settings.retry")}
              </button>
            </div>
          </SettingsCard>
        ) : members.length === 0 ? (
          <SettingsCard>
            <p className="text-sm font-medium text-gray-900">{t("settings.team.empty")}</p>
            <p className="mt-1 text-sm text-gray-500">{t("settings.team.emptyDescription")}</p>
          </SettingsCard>
        ) : (
          <SettingsCard contentClassName="p-0 md:p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-gray-100 bg-gray-50/60 text-xs font-medium text-gray-500">
                  <tr>
                    <th scope="col" className="px-4 py-3 md:px-5">
                      {t("settings.team.member")}
                    </th>
                    <th scope="col" className="px-4 py-3">
                      {t("settings.team.role")}
                    </th>
                    <th scope="col" className="px-4 py-3">
                      {t("settings.team.properties")}
                    </th>
                    <th scope="col" className="px-4 py-3">
                      {t("bookings.tableStatus")}
                    </th>
                    <th scope="col" className="px-4 py-3 md:px-5">
                      {t("settings.team.lastActive")}
                    </th>
                    <th scope="col" className="px-4 py-3 md:px-5">
                      {t("settings.team.actions")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {members.map((member) => (
                    <tr key={member.id}>
                      <td className="px-4 py-3 md:px-5">
                        <p className="font-medium text-gray-900">
                          {member.status === "pending"
                            ? t("settings.team.pendingInvite")
                            : member.name || member.email}
                        </p>
                        {(member.name || member.status === "pending") && (
                          <p className="text-xs text-gray-500">{member.email}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {member.roleName ?? t(roleLabelKeys[member.roleKey])}
                      </td>
                      <td className="max-w-64 px-4 py-3 text-gray-700">
                        {member.propertyAccessMode === "all"
                          ? t("settings.team.allFutureProperties")
                          : member.propertyIds
                              .map((propertyId) => propertyNames.get(propertyId) ?? propertyId)
                              .join(", ")}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusClass(member.status)}`}
                        >
                          {statusLabel(member.status, t)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 md:px-5">
                        {formatLastActive(member.lastActiveAt, locale, t)}
                      </td>
                      <td className="px-4 py-3 md:px-5">
                        {member.status === "pending" ? (
                          <button
                            type="button"
                            disabled={opening}
                            onClick={() => void openMember(member)}
                            className="text-sm text-primary-600"
                          >
                            {t("settings.team.resendInvitation")}
                          </button>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={opening || updatingMemberId !== null}
                              onClick={() => void openMember(member)}
                              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs"
                            >
                              {t("settings.team.editMemberAccess")}
                            </button>
                            <button
                              type="button"
                              disabled={opening || updatingMemberId !== null}
                              onClick={() => void changeStatus(member)}
                              aria-busy={updatingMemberId === member.id}
                              aria-label={
                                updatingMemberId === member.id
                                  ? t("settings.team.savingStatus", {
                                      name: member.name || member.email,
                                    })
                                  : t(
                                      member.status === "active"
                                        ? "settings.team.deactivateNamed"
                                        : "settings.team.reactivateNamed",
                                      { name: member.name || member.email },
                                    )
                              }
                              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {updatingMemberId === member.id
                                ? t("common.saving")
                                : member.status === "active"
                                  ? t("settings.team.deactivate")
                                  : t("settings.team.reactivate")}
                            </button>
                            <button
                              type="button"
                              disabled={opening || updatingMemberId !== null}
                              className="text-xs text-red-600"
                              onClick={() =>
                                setDialog({
                                  kind: "action",
                                  action: {
                                    title: t("settings.team.removeMember"),
                                    description: t("settings.team.removeConfirm", {
                                      name: member.name || member.email,
                                    }),
                                    write: async (key) => {
                                      const result = await removePmsStaff(member.id, key);
                                      return t(
                                        result.providerStatus === "revoked"
                                          ? "settings.team.memberRemoved"
                                          : "settings.team.memberRemovedPending",
                                      );
                                    },
                                  },
                                })
                              }
                            >
                              {t("settings.team.removeMember")}
                            </button>
                          </div>
                        )}
                        {actionFeedback?.memberId === member.id && (
                          <p
                            role={actionFeedback.type === "error" ? "alert" : "status"}
                            className={`mt-1 text-xs ${actionFeedback.type === "error" ? "text-red-600" : "text-emerald-700"}`}
                          >
                            {actionFeedback.message}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SettingsCard>
        )}
        {!loading && !error && (
          <TeamRoleCards
            roles={roles}
            canManage={canManageRoles}
            onCreate={() => setDialog({ kind: "role" })}
            onEdit={(role) => setDialog({ kind: "role", role })}
            onDelete={(role) =>
              setDialog({
                kind: "action",
                action: {
                  title: t("settings.team.deleteRole"),
                  description: t("settings.team.deleteRoleConfirm", { name: role.name }),
                  write: async (key) => {
                    await deletePmsTeamRole(role.id, role.revision, key);
                    return t("settings.team.roleDeleted");
                  },
                },
              })
            }
          />
        )}
        {!loading && !error && members.length > 0 && properties.length > 0 && (
          <PropertyAccessMatrix members={members} properties={properties} />
        )}
        {dialog?.kind === "member" && (
          <MemberAccessDialog
            access={dialog.access}
            memberName={dialog.name}
            roles={roles}
            properties={properties}
            canManageRoles={canManageRoles}
            onClose={() => setDialog(null)}
            onSaved={(result) =>
              saved(result ? invitationMessage(result) : t("settings.team.accessSaved"))
            }
          />
        )}
        {dialog?.kind === "role" && (
          <RoleEditorDialog
            role={dialog.role}
            roles={roles}
            canManage={canManageRoles}
            onClose={() => setDialog(null)}
            onSaved={() => saved(t("settings.team.roleSaved"))}
          />
        )}
        {dialog?.kind === "action" && (
          <TeamActionDialog
            action={dialog.action}
            onClose={() => setDialog(null)}
            onSaved={saved}
          />
        )}
      </SettingsSection>
    </SettingsLayout>
  );
}

function statusLabel(status: PmsStaffMember["status"], t: (key: string) => string): string {
  return t(`settings.team.status${status[0]!.toUpperCase()}${status.slice(1)}`);
}

function statusClass(status: PmsStaffMember["status"]): string {
  if (status === "active") return "bg-emerald-50 text-emerald-700";
  if (status === "pending") return "bg-amber-50 text-amber-700";
  return "bg-gray-100 text-gray-600";
}

function formatLastActive(
  value: string | null,
  locale: string,
  t: (key: string) => string,
): string {
  return value
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value))
    : t("settings.team.notYet");
}
