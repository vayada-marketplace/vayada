"use client";
import React, { useId } from "react";
import { PlusIcon, TrashIcon, UserGroupIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";
import { sectionCounts } from "@/lib/settings/teamPermissions";
import type { PmsTeamRole } from "@/services/api/pmsStaffClient";
import TeamSection from "./TeamSection";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const counted = (t: Translate, count: number, key: string) =>
  t(count === 1 ? `${key}One` : key, { count });

function roleStats(t: Translate, role: PmsTeamRole, adminCount: number) {
  if (role.immutable)
    return [
      t("settings.team.everySectionEditable"),
      counted(t, adminCount, "settings.team.userCount"),
    ];
  const { edit, view } = sectionCounts(role.defaultPermissions);
  return [
    counted(t, edit, "settings.team.sectionsEditable"),
    t("settings.team.viewOnlyCount", { count: view }),
    counted(t, role.memberCount, "settings.team.userCount"),
    ...(role.invitationCount
      ? [t("settings.team.invitedCount", { count: role.invitationCount })]
      : []),
  ];
}

export default function TeamRoleCards({
  roles,
  canManage,
  adminCount,
  onEdit,
  onDelete,
  onCreate,
}: {
  roles: PmsTeamRole[];
  canManage: boolean;
  adminCount: number;
  onEdit: (role: PmsTeamRole) => void;
  onDelete: (role: PmsTeamRole) => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  const hasCustomRoles = roles.some((role) => !role.immutable);
  const reasonId = useId();
  return (
    <TeamSection
      title={t("settings.team.rolesHeading")}
      description={t("settings.team.rolesDescription")}
    >
      <div className="space-y-3 rounded-xl border border-gray-200 bg-gray-50 p-3 sm:p-4">
        {roles.map((role) => {
          const inUse = role.memberCount > 0 || role.invitationCount > 0;
          return (
            <article
              key={role.id}
              className="flex flex-col gap-4 rounded-xl border border-gray-200 bg-white p-4 sm:min-h-[5.75rem] sm:flex-row sm:items-center sm:gap-6 sm:px-5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="break-words font-semibold text-gray-900">{role.name}</h3>
                  {role.immutable && (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-gray-600">
                      {t("settings.team.systemBadge")}
                    </span>
                  )}
                </div>
                {(role.description || role.immutable) && (
                  <p className="mt-1 break-words text-sm text-gray-600">
                    {role.immutable
                      ? [role.description, t("settings.team.adminFullAccess")]
                          .filter(Boolean)
                          .join(" ")
                      : role.description}
                  </p>
                )}
                <p className="mt-1 text-xs text-gray-500">
                  {roleStats(t, role, adminCount).join(" · ")}
                </p>
              </div>
              <div className="flex gap-2 sm:w-56 sm:shrink-0 sm:justify-end">
                <button
                  type="button"
                  onClick={() => onEdit(role)}
                  className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:flex-none"
                >
                  {t(
                    canManage && !role.immutable
                      ? "settings.team.editPermissions"
                      : "settings.team.viewPermissions",
                  )}
                </button>
                {canManage && !role.immutable && (
                  <button
                    type="button"
                    disabled={inUse}
                    onClick={() => onDelete(role)}
                    aria-label={t("settings.team.deleteRoleNamed", { name: role.name })}
                    aria-describedby={inUse ? `${reasonId}-${role.id}` : undefined}
                    title={inUse ? t("settings.team.deleteRoleInUse") : undefined}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-gray-400 disabled:opacity-50 disabled:hover:bg-white"
                  >
                    <TrashIcon aria-hidden="true" className="h-4 w-4" />
                  </button>
                )}
                {canManage && !role.immutable && inUse && (
                  <span id={`${reasonId}-${role.id}`} className="sr-only">
                    {t("settings.team.deleteRoleInUse")}
                  </span>
                )}
              </div>
            </article>
          );
        })}
        {!hasCustomRoles && (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white px-4 py-8 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-50">
              <UserGroupIcon aria-hidden="true" className="h-5 w-5 text-primary-600" />
            </span>
            <div>
              <p className="font-semibold text-gray-900">{t("settings.team.noCustomRoles")}</p>
              <p className="mt-1 text-sm text-gray-500">
                {t(
                  canManage
                    ? "settings.team.noCustomRolesDescription"
                    : "settings.team.noCustomRolesManager",
                )}
              </p>
            </div>
            {canManage && (
              <button
                type="button"
                onClick={onCreate}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
              >
                <PlusIcon aria-hidden="true" className="h-4 w-4" />
                {t("settings.team.createRole")}
              </button>
            )}
          </div>
        )}
      </div>
      {canManage && hasCustomRoles && (
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:w-auto"
        >
          <PlusIcon aria-hidden="true" className="h-4 w-4" />
          {t("settings.team.createRole")}
        </button>
      )}
    </TeamSection>
  );
}
