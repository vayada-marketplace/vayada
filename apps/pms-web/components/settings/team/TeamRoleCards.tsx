"use client";
import React from "react";
import { useTranslation } from "@/lib/i18n";
import { sectionCounts } from "@/lib/settings/teamPermissions";
import type { PmsTeamRole } from "@/services/api/pmsStaffClient";

export default function TeamRoleCards({
  roles,
  canManage,
  onEdit,
  onDelete,
  onCreate,
}: {
  roles: PmsTeamRole[];
  canManage: boolean;
  onEdit: (role: PmsTeamRole) => void;
  onDelete: (role: PmsTeamRole) => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-4" aria-label={t("settings.team.rolesHeading")}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900">{t("settings.team.rolesHeading")}</h2>
        {canManage && (
          <button
            type="button"
            onClick={onCreate}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            {t("settings.team.createRole")}
          </button>
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {roles.map((role) => {
          const counts = sectionCounts(role.defaultPermissions);
          return (
            <article
              key={role.id}
              className="flex flex-col rounded-xl border border-gray-200 bg-white p-5"
            >
              <h3 className="font-semibold text-gray-900">{role.name}</h3>
              <p className="mt-2 flex-1 text-sm text-gray-500">{role.description}</p>
              <p className="mt-4 text-xs text-gray-600">
                {t(
                  role.immutable
                    ? "settings.team.adminFullAccess"
                    : "settings.team.permissionCounts",
                  counts,
                )}
              </p>
              {!role.immutable && (
                <p className="mt-2 text-xs text-gray-500">
                  {t("settings.team.assignedCounts", {
                    members: role.memberCount,
                    invited: role.invitationCount,
                  })}
                </p>
              )}
              <div className="mt-4 flex gap-4">
                <button
                  type="button"
                  onClick={() => onEdit(role)}
                  className="text-sm font-medium text-primary-600"
                >
                  {t(
                    canManage && !role.immutable
                      ? "settings.team.editRole"
                      : "settings.team.viewPermissions",
                  )}
                </button>
                {canManage && !role.immutable && (
                  <button
                    type="button"
                    disabled={role.memberCount > 0 || role.invitationCount > 0}
                    onClick={() => onDelete(role)}
                    className="text-sm text-red-600 disabled:opacity-40"
                  >
                    {t("settings.team.deleteRole")}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
