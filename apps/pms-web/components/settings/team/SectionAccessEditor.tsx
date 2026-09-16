"use client";
import React, { useId } from "react";
import { useTranslation } from "@/lib/i18n";
import {
  changeProductSections,
  changeSectionAccess,
  changeSectionDetail,
  sectionAccess,
  supportsSectionAccess,
  teamSections,
  type TeamAccessLevel,
} from "@/lib/settings/teamPermissions";

export default function SectionAccessEditor({
  permissions,
  allowedPermissions,
  onChange,
  disabled = false,
  productAccess = { pms: true, booking: true },
}: {
  permissions: string[];
  allowedPermissions: string[];
  onChange: (permissions: string[]) => void;
  disabled?: boolean;
  productAccess?: { pms: boolean; booking: boolean };
}) {
  const { t } = useTranslation();
  const id = useId();
  const levels: TeamAccessLevel[] = ["none", "view", "edit"];
  return (
    <div className="space-y-5">
      {(["pms", "booking"] as const).map((product) => (
        <fieldset
          key={product}
          disabled={disabled}
          className="rounded-xl border border-gray-200 disabled:opacity-60"
        >
          <legend className="mx-4 px-1 text-sm font-semibold text-gray-900">
            {t(`settings.team.products.${product}`)}
          </legend>
          <div className="flex flex-wrap items-center justify-end gap-2 border-b border-gray-100 px-4 py-3">
            {levels.map((level) => (
              <button
                key={level}
                type="button"
                disabled={!productAccess[product]}
                onClick={() =>
                  onChange(changeProductSections(permissions, product, level, allowedPermissions))
                }
                className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-primary-600"
              >
                {t(`settings.team.bulk.${level}`)}
              </button>
            ))}
          </div>
          {teamSections
            .filter((section) => section.product === product)
            .map((section) => (
              <fieldset
                key={section.id}
                disabled={!productAccess[product] && section.id !== "team"}
                className="border-b border-gray-100 px-4 py-3 last:border-0 disabled:opacity-60"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p
                      id={`${id}-${product}-${section.id}`}
                      className="text-sm font-medium text-gray-900"
                    >
                      {t(`settings.team.section.${product}.${section.id}`)}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {t(`settings.team.section.${product}.${section.id}.description`)}
                    </p>
                  </div>
                  {section.read.length || section.edit.length ? (
                    <div
                      role="radiogroup"
                      aria-labelledby={`${id}-${product}-${section.id}`}
                      className="inline-flex rounded-lg border border-gray-200 p-0.5"
                    >
                      {levels.map((level) => {
                        const partial =
                          sectionAccess(permissions, section) === "none" &&
                          section.details?.some((detail) => permissions.includes(detail.key));
                        const selected = !partial && sectionAccess(permissions, section) === level;
                        const unavailable = !supportsSectionAccess(
                          section,
                          level,
                          allowedPermissions,
                        );
                        return (
                          <label
                            key={level}
                            className={`relative rounded-md px-2.5 py-1.5 text-xs font-medium focus-within:ring-2 focus-within:ring-primary-600 ${selected ? "bg-primary-600 text-white" : "text-gray-600"} ${unavailable ? "cursor-not-allowed opacity-40" : "cursor-pointer"}`}
                            title={unavailable ? t("settings.team.unavailable") : undefined}
                          >
                            <input
                              type="radio"
                              name={`${id}-${product}-${section.id}`}
                              value={level}
                              checked={selected}
                              disabled={unavailable}
                              onChange={() =>
                                onChange(
                                  changeSectionAccess(
                                    permissions,
                                    section,
                                    level,
                                    allowedPermissions,
                                  ),
                                )
                              }
                              className="sr-only"
                            />
                            {t(`settings.team.level.${level}`)}
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="text-xs text-gray-400">{t("settings.team.unavailable")}</span>
                  )}
                </div>
                {section.details?.length ? (
                  <details className="mt-2 text-xs text-gray-600">
                    <summary className="cursor-pointer py-1 focus-visible:ring-2 focus-visible:ring-primary-600">
                      {t("settings.team.specificAccess")} ·{" "}
                      {section.details.filter((detail) => permissions.includes(detail.key)).length}{" "}
                      {t("settings.team.enabled")}
                    </summary>
                    <div className="space-y-2 py-2">
                      {section.details.map((detail) => (
                        <label key={detail.key} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={permissions.includes(detail.key)}
                            disabled={!allowedPermissions.includes(detail.key)}
                            onChange={(event) =>
                              onChange(
                                changeSectionDetail(
                                  permissions,
                                  section,
                                  detail.key,
                                  event.target.checked,
                                  allowedPermissions,
                                ),
                              )
                            }
                            className="h-4 w-4 rounded border-gray-300 accent-primary-600"
                          />
                          {t(`settings.team.permission.${detail.key}`)}
                        </label>
                      ))}
                    </div>
                  </details>
                ) : null}
              </fieldset>
            ))}
        </fieldset>
      ))}
    </div>
  );
}
