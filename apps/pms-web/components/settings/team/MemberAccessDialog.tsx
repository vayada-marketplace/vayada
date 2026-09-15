"use client";
import React, { useRef, useState } from "react";
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
  onSaved,
}: {
  access?: PmsStaffAccess;
  memberName?: string;
  roles: PmsTeamRole[];
  properties: { id: string; name: string }[];
  canManageRoles: boolean;
  onClose: () => void;
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
        <TeamAccessFields
          draft={draft}
          onChange={setDraft}
          roles={choices}
          properties={properties}
          access={access}
          disabled={mutation.busy || restricted}
        />
      </form>
    </Modal>
  );
}
