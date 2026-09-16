"use client";
import React, { useState } from "react";
import Modal from "@/components/Modal";
import { useTranslation } from "@/lib/i18n";
import {
  createPmsTeamRole,
  updatePmsTeamRole,
  type PmsTeamRole,
} from "@/services/api/pmsStaffClient";
import { teamSections } from "@/lib/settings/teamPermissions";
import SectionAccessEditor from "./SectionAccessEditor";
import { useTeamWrite } from "./useTeamWrite";

export default function RoleEditorDialog({
  role,
  roles,
  canManage,
  onClose,
  onSaved,
}: {
  role?: PmsTeamRole;
  roles: PmsTeamRole[];
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [permissions, setPermissions] = useState(role?.defaultPermissions ?? []);
  const [sourceId, setSourceId] = useState("");
  const mutation = useTeamWrite();
  const readOnly = !canManage || role?.immutable === true;
  const source = roles.find((item) => item.id === sourceId);
  const allowed =
    role?.allowedPermissions ??
    (source
      ? source.allowedPermissions.filter((key) => key !== "identity.staff.manage")
      : Array.from(
          new Set(
            teamSections.flatMap((section) => [
              ...section.read,
              ...section.edit,
              ...(section.details ?? []).map((detail) => detail.key),
            ]),
          ),
        ).filter((key) => key !== "identity.staff.manage"));
  const title = t(
    readOnly
      ? "settings.team.viewPermissions"
      : role
        ? "settings.team.editRole"
        : "settings.team.createRole",
  );
  async function save() {
    if (readOnly || !name.trim()) return;
    const input = {
      name: name.trim(),
      description,
      defaultPermissions: permissions,
      ...(role ? { expectedRevision: role.revision } : sourceId ? { sourceRoleId: sourceId } : {}),
    };
    const saved = await mutation.run(input, (payload, key) =>
      role
        ? updatePmsTeamRole(role.id, { ...payload, expectedRevision: role.revision }, key)
        : createPmsTeamRole(payload, key),
    );
    if (saved) onSaved();
  }
  return (
    <Modal
      maxWidth="xl"
      ariaLabel={title}
      onClose={() => {
        if (!mutation.busy) onClose();
      }}
      footer={
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            disabled={mutation.busy}
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
          >
            {t(readOnly ? "settings.team.close" : "common.cancel")}
          </button>
          {!readOnly && (
            <button
              type="submit"
              form="team-role-form"
              disabled={mutation.busy || !name.trim()}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {t(mutation.busy ? "common.saving" : "settings.team.saveRole")}
            </button>
          )}
        </div>
      }
    >
      <h2 className="mb-5 text-lg font-semibold text-gray-900">{title}</h2>
      <form
        id="team-role-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="space-y-5"
      >
        {mutation.error && (
          <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {mutation.error}
          </p>
        )}
        <fieldset disabled={readOnly || mutation.busy} className="space-y-4">
          {!role && (
            <label className="block text-sm font-medium">
              {t("settings.team.startFromRole")}
              <select
                value={sourceId}
                onChange={(event) => {
                  const selected = roles.find((item) => item.id === event.target.value);
                  setSourceId(event.target.value);
                  setPermissions(
                    selected?.defaultPermissions.filter((key) => key !== "identity.staff.manage") ??
                      [],
                  );
                }}
                className="mt-1 block w-full rounded-lg border border-gray-300 p-2 text-sm"
              >
                <option value="">{t("settings.team.blankRole")}</option>
                {roles
                  .filter((item) => !item.immutable)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label className="block text-sm font-medium">
            {t("settings.team.roleName")}
            <input
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-300 p-2 text-sm"
            />
          </label>
          <label className="block text-sm font-medium">
            {t("settings.team.roleDescription")}
            <textarea
              maxLength={1000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-300 p-2 text-sm"
              rows={2}
            />
          </label>
        </fieldset>
        {role?.immutable ? (
          <p className="rounded-xl border border-primary-100 bg-primary-50 p-4 text-sm text-primary-800">
            {t("settings.team.adminFullAccess")}
          </p>
        ) : (
          <SectionAccessEditor
            permissions={permissions}
            allowedPermissions={allowed}
            onChange={setPermissions}
            disabled={readOnly || mutation.busy}
          />
        )}
      </form>
    </Modal>
  );
}
