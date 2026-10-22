"use client";
import React, { useRef, useState } from "react";
import { InformationCircleIcon, PlusIcon } from "@heroicons/react/24/outline";
import Modal from "@/components/Modal";
import { useTranslation } from "@/lib/i18n";
import {
  assignableTeamRoles,
  initialTeamAccess,
  teamAccessConfiguration,
} from "@/lib/settings/teamAccessForm";
import {
  invitePmsStaff,
  preparePmsStaffInvitation,
  type PmsStaffInviteInput,
  savePmsStaffAccess,
  type PmsInviteResult,
  type PmsStaffAccess,
  type PmsTeamRole,
} from "@/services/api/pmsStaffClient";
import TeamAccessFields from "./TeamAccessFields";
import { useTeamWrite } from "./useTeamWrite";

// Mount a fresh dialog for each freshly loaded member snapshot.
export default function MemberAccessDialog({
  access,
  memberName,
  roles,
  properties,
  canManageRoles,
  onClose,
  onCreateRole,
  onSaved,
}: {
  access?: PmsStaffAccess;
  memberName?: string;
  roles: PmsTeamRole[];
  properties: { id: string; name: string }[];
  canManageRoles: boolean;
  onClose: () => void;
  onCreateRole?: () => void;
  onSaved: (result?: PmsInviteResult) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => initialTeamAccess(access));
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const mutation = useTeamWrite();
  const preparedInvitation = useRef<{ key: string; input: PmsStaffInviteInput }>();
  const choices = assignableTeamRoles(roles, canManageRoles);
  const selected = choices.find((role) => role.id === draft.roleId);
  // A new account has no roles to give until the host creates one (VAY-2276).
  const noRoles = !access && choices.length === 0;
  const validRole = !!selected || (!!access && !access.roleDefinitionId && !draft.roleId);
  const restricted =
    !canManageRoles &&
    !!access &&
    ((access.roleKey === "hotel_manager" &&
      (!access.roleDefinitionId || access.roleDefinition?.presetKey === "agency_manager")) ||
      access.roleKey === "external_owner" ||
      access.configuredPermissions.includes("identity.staff.manage"));
  const disabled =
    restricted ||
    !validRole ||
    (!!access && draft.roleId !== (access.roleDefinitionId ?? "") && !draft.resetOverrides) ||
    (draft.propertyAccessMode === "assigned" && draft.propertyIds.length === 0) ||
    (!access && !email.trim());
  const title = t(access ? "settings.team.editMemberAccess" : "settings.team.inviteTeammate");
  async function save() {
    if (disabled) return;
    let result: PmsInviteResult | undefined;
    // Build inside run so stale/unavailable snapshots are handled as a form error.
    const saved = await mutation.run(
      { draft, email: email.trim(), name: name.trim() },
      async (input, key) => {
        const configuration = teamAccessConfiguration(input.draft, choices, access);
        if (access)
          await savePmsStaffAccess(
            access.membershipId,
            {
              ...configuration,
              expectedRevision: access.revision,
              membershipStatus: input.draft.status,
            },
            key,
          );
        else {
          if (preparedInvitation.current?.key !== key) {
            const prepared = await preparePmsStaffInvitation(input.email);
            preparedInvitation.current = {
              key,
              input: {
                ...configuration,
                email: input.email,
                ...(input.name ? { name: input.name } : {}),
                configurationRevision: prepared.configurationRevision,
              },
            };
          }
          result = await invitePmsStaff(preparedInvitation.current.input, key);
        }
      },
    );
    if (saved) onSaved(result);
  }
  return (
    <Modal
      maxWidth="xl"
      ariaLabel={title}
      onClose={() => {
        if (!mutation.busy) onClose();
      }}
      footer={
        <div className="flex justify-end gap-3">
          <button
            type="button"
            disabled={mutation.busy}
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
          >
            {t("common.cancel")}
          </button>
          <button
            type="submit"
            form="team-member-form"
            disabled={disabled || mutation.busy}
            className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {t(
              mutation.busy
                ? "common.saving"
                : access
                  ? "settings.team.saveAccess"
                  : "settings.team.sendInvitation",
            )}
          </button>
        </div>
      }
    >
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      {memberName && <p className="mt-1 text-sm text-gray-500">{memberName}</p>}
      <form
        id="team-member-form"
        className="mt-5 space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {(mutation.error || restricted) && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {mutation.error || t("settings.team.forbidden")}
          </p>
        )}
        {!access && (
          <fieldset disabled={mutation.busy} className="space-y-4">
            <label className="block text-sm font-medium">
              {t("settings.team.inviteName")}
              <input
                value={name}
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
                className="mt-1 block w-full rounded-lg border border-gray-300 p-2"
              />
            </label>
            <label className="block text-sm font-medium">
              {t("settings.team.inviteEmail")}
              <input
                required
                type="email"
                value={email}
                maxLength={320}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-1 block w-full rounded-lg border border-gray-300 p-2"
              />
            </label>
          </fieldset>
        )}
        {noRoles ? (
          <div className="space-y-1.5">
            <p className="text-sm font-medium">{t("settings.team.accessRole")}</p>
            <div className="flex flex-col gap-3 rounded-xl border border-primary-100 bg-primary-50 p-4 sm:flex-row sm:items-center">
              <div className="flex flex-1 gap-2.5">
                <InformationCircleIcon
                  aria-hidden="true"
                  className="h-5 w-5 shrink-0 text-primary-600"
                />
                <div>
                  <p className="text-sm font-semibold text-gray-900">
                    {t("settings.team.createRoleFirst")}
                  </p>
                  <p className="mt-0.5 text-sm text-gray-600">
                    {t(
                      canManageRoles && onCreateRole
                        ? "settings.team.createRoleFirstDescription"
                        : "settings.team.createRoleFirstAskAdmin",
                    )}
                  </p>
                </div>
              </div>
              {canManageRoles && onCreateRole && (
                <button
                  type="button"
                  onClick={onCreateRole}
                  className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  <PlusIcon aria-hidden="true" className="h-4 w-4" />
                  {t("settings.team.createRole")}
                </button>
              )}
            </div>
          </div>
        ) : (
          <TeamAccessFields
            draft={draft}
            onChange={setDraft}
            roles={choices}
            properties={properties}
            access={access}
            disabled={mutation.busy || restricted}
          />
        )}
      </form>
    </Modal>
  );
}
