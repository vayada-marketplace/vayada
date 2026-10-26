"use client";
import React from "react";
import { CheckIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";
import type { PmsAccountAdmin, PmsStaffMember } from "@/services/api/pmsStaffClient";
import TeamSection, { teamCardClass } from "./TeamSection";

function AccessCell({ assigned, active }: { assigned: boolean; active: boolean }) {
  const { t } = useTranslation();
  return (
    <td className="px-3 py-3 text-center">
      {assigned ? (
        <CheckIcon
          aria-hidden="true"
          className={`mx-auto h-5 w-5 ${active ? "text-primary-600" : "text-gray-400"}`}
        />
      ) : (
        <span aria-hidden="true" className="text-gray-300">
          —
        </span>
      )}
      <span className="sr-only">
        {t(assigned ? "settings.team.propertyAssigned" : "settings.team.propertyUnassigned")}
      </span>
    </td>
  );
}

export default function PropertyAccessMatrix({
  members,
  admins = [],
  properties,
  roleLabel,
}: {
  members: PmsStaffMember[];
  admins?: PmsAccountAdmin[];
  properties: { id: string; name: string }[];
  roleLabel: (member: PmsStaffMember) => string;
}) {
  const { t } = useTranslation();
  return (
    <TeamSection
      title={t("settings.team.matrixHeading")}
      description={t("settings.team.matrixDescription")}
    >
      {/* relative: the cells' sr-only labels are absolutely positioned; without a positioned card they
          escape its scrolling and widen the page on phones. */}
      <div className={`${teamCardClass} relative overflow-x-auto`}>
        <table
          className="w-full table-fixed text-left text-sm"
          style={{ minWidth: `${15 + properties.length * 7.5}rem` }}
        >
          <colgroup>
            <col className="w-40 md:w-60" />
            {properties.map((property) => (
              <col key={property.id} />
            ))}
          </colgroup>
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              <th
                scope="col"
                className="px-5 py-3 text-[11px] font-medium uppercase tracking-wider text-gray-500"
              >
                {t("settings.team.userColumn")}
              </th>
              {properties.map((property) => (
                <th
                  key={property.id}
                  scope="col"
                  className="break-words px-3 py-3 text-center text-[13px] font-medium text-gray-600"
                >
                  {property.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {admins.map((admin) => (
              <tr key={admin.membershipId} className="h-[3.75rem]">
                <th scope="row" className="px-5 py-2 font-normal">
                  <span
                    title={admin.name || admin.email}
                    className="block truncate font-medium text-gray-900"
                  >
                    {admin.name || admin.email}
                  </span>
                  <span className="block truncate text-xs text-gray-500">
                    {t(
                      admin.active ? "settings.team.accountAdmin" : "settings.team.accessSuspended",
                    )}
                  </span>
                </th>
                {properties.map((property) => (
                  <AccessCell key={property.id} assigned={admin.active} active={admin.active} />
                ))}
              </tr>
            ))}
            {members.map((member) => (
              <tr key={member.id} className="h-[3.75rem]">
                <th scope="row" className="px-5 py-2 font-normal">
                  <span
                    title={member.name || member.email}
                    className="block truncate font-medium text-gray-900"
                  >
                    {member.name || member.email}
                  </span>
                  <span className="block truncate text-xs text-gray-500">
                    {member.status === "active"
                      ? roleLabel(member)
                      : t(
                          member.status === "pending"
                            ? "settings.team.matrixInvited"
                            : "settings.team.matrixSuspended",
                          { role: roleLabel(member) },
                        )}
                  </span>
                </th>
                {properties.map((property) => (
                  <AccessCell
                    key={property.id}
                    assigned={
                      member.propertyAccessMode === "all" ||
                      member.propertyIds.includes(property.id)
                    }
                    active={member.status === "active"}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TeamSection>
  );
}
