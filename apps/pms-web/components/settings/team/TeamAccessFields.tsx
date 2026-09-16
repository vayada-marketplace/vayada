"use client";
import React from "react";
import { useTranslation } from "@/lib/i18n";
import { initialTeamAccess, type TeamAccessDraft } from "@/lib/settings/teamAccessForm";
import type { PmsStaffAccess, PmsTeamRole } from "@/services/api/pmsStaffClient";
import SectionAccessEditor from "./SectionAccessEditor";

export default function TeamAccessFields({
  draft,
  onChange,
  roles,
  properties,
  access,
  disabled,
}: {
  draft: TeamAccessDraft;
  onChange: (draft: TeamAccessDraft) => void;
  roles: PmsTeamRole[];
  properties: { id: string; name: string }[];
  access?: PmsStaffAccess;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const role = roles.find((item) => item.id === draft.roleId);
  const owner = (role?.baseRoleKey ?? access?.roleKey) === "external_owner";
  const allowed =
    role?.allowedPermissions ??
    roles.find((item) => item.baseRoleKey === access?.roleKey)?.allowedPermissions ??
    access?.configuredPermissions ??
    [];
  const unavailableIds = draft.propertyIds.filter(
    (id) => !properties.some((property) => property.id === id),
  );
  const inputClass = "mt-1 block w-full rounded-lg border border-gray-300 p-2 text-sm";
  return (
    <>
      <fieldset disabled={disabled} className="space-y-5">
        <label className="block text-sm font-medium">
          {t("settings.team.accessRole")}
          <select
            required={!access || !!access.roleDefinitionId}
            value={draft.roleId}
            className={inputClass}
            onChange={(event) => {
              const selected = roles.find((item) => item.id === event.target.value);
              const original = access && event.target.value === (access.roleDefinitionId ?? "");
              onChange({
                ...draft,
                roleId: event.target.value,
                permissions: original
                  ? [...access.configuredPermissions]
                  : [...(selected?.defaultPermissions ?? [])],
                resetOverrides: !access,
                propertyAccessMode:
                  selected?.securityClass === "external_owner"
                    ? "assigned"
                    : draft.propertyAccessMode,
              });
            }}
          >
            <option value="" disabled={!access || !!access.roleDefinitionId}>
              {t(
                access && !access.roleDefinitionId
                  ? "settings.team.keepCurrentRole"
                  : "settings.team.selectRole",
              )}
            </option>
            {roles.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {access && draft.roleId !== (access.roleDefinitionId ?? "") && (
          <label className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            <input
              type="checkbox"
              checked={draft.resetOverrides}
              onChange={(event) => onChange({ ...draft, resetOverrides: event.target.checked })}
            />
            {t("settings.team.confirmRoleReset")}
          </label>
        )}
        {access && (
          <label className="block text-sm font-medium">
            {t("settings.team.accessStatus")}
            <select
              value={draft.status}
              className={inputClass}
              onChange={(event) =>
                onChange({ ...draft, status: event.target.value as TeamAccessDraft["status"] })
              }
            >
              <option value="active">{t("settings.team.accessActive")}</option>
              <option value="suspended">{t("settings.team.accessSuspended")}</option>
            </select>
          </label>
        )}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">{t("settings.team.productAccess")}</h3>
          {(["pms", "booking"] as const).map((product) => (
            <label key={product} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.productAccess[product]}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    productAccess: { ...draft.productAccess, [product]: event.target.checked },
                  })
                }
              />
              {t(`settings.team.products.${product}`)}
            </label>
          ))}
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">{t("settings.team.propertyAccess")}</h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="team-property-mode"
              disabled={owner}
              checked={draft.propertyAccessMode === "all"}
              onChange={() => onChange({ ...draft, propertyAccessMode: "all" })}
            />
            {t("settings.team.allFutureProperties")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="team-property-mode"
              checked={draft.propertyAccessMode === "assigned"}
              onChange={() => onChange({ ...draft, propertyAccessMode: "assigned" })}
            />
            {t("settings.team.selectedProperties")}
          </label>
          {draft.propertyAccessMode === "assigned" && (
            <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border border-gray-200 p-3">
              {properties.map((property) => (
                <label key={property.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.propertyIds.includes(property.id)}
                    onChange={(event) =>
                      onChange({
                        ...draft,
                        propertyIds: event.target.checked
                          ? [...draft.propertyIds, property.id]
                          : draft.propertyIds.filter((id) => id !== property.id),
                      })
                    }
                  />
                  {property.name}
                </label>
              ))}
              {unavailableIds.length > 0 && (
                <p className="text-sm text-amber-800">
                  {t("settings.team.unavailableProperties", { count: unavailableIds.length })}
                </p>
              )}
              {draft.propertyIds.length === 0 && (
                <p className="text-sm text-gray-500">{t("settings.team.chooseProperty")}</p>
              )}
            </div>
          )}
        </div>
        {role && (
          <button
            type="button"
            className="text-sm font-medium text-primary-600"
            onClick={() =>
              onChange({
                ...draft,
                permissions: [...role.defaultPermissions],
                resetOverrides: true,
              })
            }
          >
            {t("settings.team.resetDefaults")}
          </button>
        )}
        {access && !role && (
          <button
            type="button"
            className="text-sm font-medium text-primary-600"
            onClick={() =>
              onChange({
                ...draft,
                permissions: initialTeamAccess(access).permissions,
                resetOverrides: false,
              })
            }
          >
            {t("settings.team.resetCurrentAccess")}
          </button>
        )}
      </fieldset>
      <SectionAccessEditor
        permissions={draft.permissions}
        allowedPermissions={allowed}
        onChange={(permissions) => onChange({ ...draft, permissions })}
        disabled={disabled || (!role && !access)}
        productAccess={draft.productAccess}
      />
    </>
  );
}
