"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { UserPlusIcon } from "@heroicons/react/24/outline";
import { SettingsCard, SettingsSection } from "@vayada/settings-ui";

import ConfirmDialog from "@/components/ConfirmDialog";
import { SettingsSubPage } from "@/components/settings/SettingsSubPage";
import AccountAdminCard from "@/components/settings/team/AccountAdminCard";
import AdminTransferDialog from "@/components/settings/team/AdminTransferDialog";
import PropertyAccessMatrix from "@/components/settings/team/PropertyAccessMatrix";
import MemberAccessDialog from "@/components/settings/team/MemberAccessDialog";
import RoleEditorDialog from "@/components/settings/team/RoleEditorDialog";
import TeamMemberTable from "@/components/settings/team/TeamMemberTable";
import TeamRoleCards from "@/components/settings/team/TeamRoleCards";
import TeamActionDialog, { type TeamAction } from "@/components/settings/team/TeamActionDialog";
import { useTranslation } from "@/lib/i18n";
import {
  clearPendingAdminTransfer,
  completePendingAdminTransfer,
  isTerminalAdminTransferError,
} from "@/services/auth/adminTransfer";
import { listPmsProperties, type PmsPropertySummary } from "@/services/api/pmsPropertyClient";
import {
  getPmsStaffRoster,
  getPmsAccountAdmins,
  type PmsAccountAdmin,
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
  const { t } = useTranslation();
  const [admins, setAdmins] = useState<PmsAccountAdmin[]>([]);
  const [actorMembershipId, setActorMembershipId] = useState("");
  const [roles, setRoles] = useState<PmsTeamRole[]>([]);
  const [canManageRoles, setCanManageRoles] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [opening, setOpening] = useState(false);
  const [dialog, setDialog] = useState<
    | { kind: "member"; access?: PmsStaffAccess; name?: string }
    | { kind: "role"; role?: PmsTeamRole; thenInvite?: boolean }
    | { kind: "action"; action: TeamAction }
    | { kind: "transfer" }
    | null
  >(null);
  const [members, setMembers] = useState<PmsStaffMember[]>([]);
  const [properties, setProperties] = useState<PmsPropertySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatingMemberId, setUpdatingMemberId] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState<PmsStaffMember | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{
    memberId: string;
    type: "error" | "success";
    message: string;
  } | null>(null);
  const [transferCompletion, setTransferCompletion] = useState<"idle" | "busy" | "retry">("idle");
  const handledTransferCallback = useRef(false);

  const loadRoster = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nextMembers, nextProperties, catalog, account] = await Promise.all([
        getPmsStaffRoster(),
        listPmsProperties(),
        getPmsTeamRoles(),
        getPmsAccountAdmins(),
      ]);
      setAdmins(account.admins);
      setActorMembershipId(account.actorMembershipId);
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

  const completeTransfer = useCallback(async () => {
    setTransferCompletion("busy");
    try {
      const outcome = await completePendingAdminTransfer();
      setFeedback(
        outcome === "missing"
          ? t("settings.team.adminTransferMissing")
          : t("settings.team.adminTransferComplete"),
      );
      setTransferCompletion("idle");
      window.history.replaceState({}, "", "/settings/team");
      if (outcome !== "missing") void loadRoster();
    } catch (error) {
      if (isTerminalAdminTransferError(error)) {
        clearPendingAdminTransfer();
        setTransferCompletion("idle");
        setFeedback(t("settings.team.adminTransferError"));
        window.history.replaceState({}, "", "/settings/team");
      } else {
        setTransferCompletion("retry");
        setFeedback(t("settings.team.adminTransferRetry"));
      }
    }
  }, [loadRoster, t]);

  useEffect(() => {
    if (handledTransferCallback.current || typeof window === "undefined") return;
    const result = new URLSearchParams(window.location.search).get("adminTransfer");
    if (!result) return;
    handledTransferCallback.current = true;
    if (result === "verified") void completeTransfer();
    else {
      clearPendingAdminTransfer();
      setFeedback(t("settings.team.adminTransferError"));
      window.history.replaceState({}, "", "/settings/team");
    }
  }, [completeTransfer, t]);

  const changeStatus = async (member: PmsStaffMember, confirmed = false) => {
    const nextStatus = member.status === "active" ? "deactivated" : "active";
    const label = member.name || member.email;
    setDeactivating(null);
    if (nextStatus === "deactivated" && !confirmed) {
      setDeactivating(member);
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
  const roleLabel = (member: PmsStaffMember) => member.roleName ?? t(roleLabelKeys[member.roleKey]);
  const removeMember = (member: PmsStaffMember) =>
    setDialog({
      kind: "action",
      action: {
        title: t("settings.team.removeMember"),
        description: t("settings.team.removeConfirm", { name: member.name || member.email }),
        write: async (key) => {
          const result = await removePmsStaff(member.id, key);
          return t(
            result.providerStatus === "revoked"
              ? "settings.team.memberRemoved"
              : "settings.team.memberRemovedPending",
          );
        },
      },
    });

  return (
    <SettingsSubPage
      title={t("settings.team.pageTitle")}
      breadcrumb={t("settings.navigation.team")}
      // Once loaded, the subtitle is the team at a glance (the approved VAY-2277 design).
      description={
        loading || error
          ? t("settings.team.description")
          : t("settings.team.summary", {
              active: members.filter((member) => member.status === "active").length,
              invited: members.filter((member) => member.status === "pending").length,
              suspended: members.filter((member) => member.status === "deactivated").length,
              properties: properties.length,
            })
      }
      actions={
        !loading &&
        !error && (
          <button
            type="button"
            disabled={opening}
            onClick={() => setDialog({ kind: "member" })}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            <UserPlusIcon aria-hidden="true" className="h-4 w-4" />
            {t("settings.team.inviteTeammate")}
          </button>
        )
      }
    >
      <SettingsSection id="team">
        {feedback && (
          <div
            role={transferCompletion === "retry" ? "alert" : "status"}
            className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3 text-sm"
          >
            <p>{feedback}</p>
            {transferCompletion === "retry" && (
              <button
                type="button"
                onClick={() => void completeTransfer()}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium"
              >
                {t("settings.retry")}
              </button>
            )}
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
        ) : (
          <div className="space-y-10">
            <AccountAdminCard
              admins={admins}
              canTransfer={
                admins.length === 1 &&
                admins[0]?.active === true &&
                admins[0].roleKey === "hotel_owner" &&
                admins[0].membershipId === actorMembershipId
              }
              onTransfer={() => setDialog({ kind: "transfer" })}
            />
            <TeamMemberTable
              admins={admins}
              members={members}
              actorMembershipId={actorMembershipId}
              propertyNames={propertyNames}
              roleLabel={roleLabel}
              opening={opening}
              updatingMemberId={updatingMemberId}
              feedback={actionFeedback}
              onEdit={(member) => void openMember(member)}
              onResend={(member) => void openMember(member)}
              onToggleStatus={(member) => void changeStatus(member)}
              onRemove={removeMember}
            />
            <TeamRoleCards
              roles={roles}
              canManage={canManageRoles}
              adminCount={admins.length}
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
            {/* The overview starts once there is a teammate; with only the admin it says nothing new. */}
            {members.length > 0 && properties.length > 0 && (
              <PropertyAccessMatrix
                admins={admins}
                members={members}
                properties={properties}
                roleLabel={roleLabel}
              />
            )}
          </div>
        )}
        {dialog?.kind === "member" && (
          <MemberAccessDialog
            access={dialog.access}
            memberName={dialog.name}
            roles={roles}
            properties={properties}
            canManageRoles={canManageRoles}
            onClose={() => setDialog(null)}
            onCreateRole={() => setDialog({ kind: "role", thenInvite: true })}
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
            onSaved={() => {
              const thenInvite = dialog.thenInvite;
              saved(t("settings.team.roleSaved"));
              // A role created from the invite dialog goes straight back to inviting.
              if (thenInvite) setDialog({ kind: "member" });
            }}
          />
        )}
        {dialog?.kind === "action" && (
          <TeamActionDialog
            action={dialog.action}
            onClose={() => setDialog(null)}
            onSaved={saved}
          />
        )}
        {deactivating && (
          <ConfirmDialog
            title={t("settings.team.deactivateNamed", {
              name: deactivating.name || deactivating.email,
            })}
            message={t("settings.team.deactivateConfirm", {
              name: deactivating.name || deactivating.email,
            })}
            confirmLabel={t("settings.team.deactivate")}
            cancelLabel={t("common.cancel")}
            variant="danger"
            onConfirm={() => void changeStatus(deactivating, true)}
            onCancel={() => setDeactivating(null)}
          />
        )}
        {dialog?.kind === "transfer" && (
          <AdminTransferDialog
            actorMembershipId={actorMembershipId}
            members={members}
            roles={roles}
            onClose={() => setDialog(null)}
          />
        )}
      </SettingsSection>
    </SettingsSubPage>
  );
}
