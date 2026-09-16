"use client";
import React from "react";
import { useTranslation } from "@/lib/i18n";
import type { PmsAccountAdmin, PmsStaffMember } from "@/services/api/pmsStaffClient";

export default function PropertyAccessMatrix({
  members,
  admins = [],
  properties,
}: {
  members: PmsStaffMember[];
  admins?: PmsAccountAdmin[];
  properties: { id: string; name: string }[];
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-3" aria-label={t("settings.team.matrixHeading")}>
      <h2 className="text-lg font-semibold text-gray-900">{t("settings.team.matrixHeading")}</h2>
      <p className="text-sm text-gray-500">{t("settings.team.matrixDescription")}</p>
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-100 bg-gray-50">
            <tr>
              <th scope="col" className="px-4 py-3">
                {t("settings.team.member")}
              </th>
              {properties.map((property) => (
                <th key={property.id} scope="col" className="px-4 py-3">
                  {property.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {admins.map((admin) => (
              <tr key={admin.membershipId}>
                <th scope="row" className="px-4 py-3 font-normal">
                  <span className="block font-medium">{admin.name || admin.email}</span>
                  <span className="text-xs text-gray-500">
                    {t(
                      admin.active ? "settings.team.accountAdmin" : "settings.team.accessSuspended",
                    )}
                  </span>
                </th>
                {properties.map((property) => (
                  <td key={property.id} className="px-4 py-3 text-gray-600">
                    {t(
                      admin.active
                        ? "settings.team.propertyAssigned"
                        : "settings.team.propertyUnassigned",
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {members.map((member) => (
              <tr key={member.id}>
                <th scope="row" className="px-4 py-3 font-normal">
                  <span className="block font-medium">{member.name || member.email}</span>
                  <span className="text-xs text-gray-500">
                    {t(
                      member.status === "active"
                        ? "settings.team.accessActive"
                        : member.status === "pending"
                          ? "settings.team.pendingInvite"
                          : "settings.team.accessSuspended",
                    )}
                  </span>
                </th>
                {properties.map((property) => (
                  <td key={property.id} className="px-4 py-3 text-gray-600">
                    {t(
                      member.propertyIds.includes(property.id)
                        ? "settings.team.propertyAssigned"
                        : "settings.team.propertyUnassigned",
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
