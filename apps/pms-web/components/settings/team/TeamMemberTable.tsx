"use client";
import React from "react";
import { PencilIcon, UserGroupIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";
import type { PmsAccountAdmin, PmsStaffMember } from "@/services/api/pmsStaffClient";
import TeamRowMenu from "./TeamRowMenu";
import TeamSection, { teamCardClass } from "./TeamSection";

// One table from xl up (below that the settings column is too narrow for five columns); smaller
// screens get a two-column block per row (details | status, actions).
// The explicit table roles keep its semantics when the phone layout changes the display, and the
// header row stays readable to screen readers there: clipped in flow, not absolutely positioned,
// so it cannot widen the page.
const cell = {
  user: "col-start-1 row-start-1 min-w-0 xl:table-cell xl:px-5 xl:py-3",
  role: "col-span-2 col-start-1 row-start-2 min-w-0 pt-1 xl:table-cell xl:px-4 xl:py-3 xl:pt-3",
  properties: "col-start-1 row-start-3 min-w-0 self-center xl:table-cell xl:px-4 xl:py-3",
  status: "col-start-2 row-start-1 justify-self-end xl:table-cell xl:px-4 xl:py-3",
  actions: "col-start-2 row-start-3 justify-self-end xl:table-cell xl:px-5 xl:py-3",
};
// From md up the table uses separate borders so the header keeps the card's rounded corners
// without clipping the row menus; rows are divided by their cells' top borders.
const rowClass =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 p-4 xl:table-row xl:h-[4.25rem] xl:p-0 xl:[&:not(:first-child)>td]:border-t xl:[&:not(:first-child)>td]:border-gray-100";
const headClass =
  "truncate border-b border-gray-200 bg-gray-50 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-gray-500";

type Feedback = { memberId: string; type: "error" | "success"; message: string } | null;

function statusClass(status: PmsStaffMember["status"]): string {
  if (status === "active") return "bg-emerald-50 text-emerald-700";
  if (status === "pending") return "bg-amber-50 text-amber-700";
  return "bg-gray-100 text-gray-600";
}

function StatusBadge({ status }: { status: PmsStaffMember["status"] }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${statusClass(status)}`}
    >
      {t(`settings.team.status${status[0]!.toUpperCase()}${status.slice(1)}`)}
    </span>
  );
}

export default function TeamMemberTable({
  admins,
  members,
  actorMembershipId,
  propertyNames,
  roleLabel,
  opening,
  updatingMemberId,
  feedback,
  onEdit,
  onResend,
  onToggleStatus,
  onRemove,
}: {
  admins: PmsAccountAdmin[];
  members: PmsStaffMember[];
  actorMembershipId: string;
  propertyNames: Map<string, string>;
  roleLabel: (member: PmsStaffMember) => string;
  opening: boolean;
  updatingMemberId: string | null;
  feedback: Feedback;
  onEdit: (member: PmsStaffMember) => void;
  onResend: (member: PmsStaffMember) => void;
  onToggleStatus: (member: PmsStaffMember) => void;
  onRemove: (member: PmsStaffMember) => void;
}) {
  const { t, locale } = useTranslation();
  const you = <span className="text-sm text-gray-500">{t("settings.team.you")}</span>;
  const lastActive = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(value))
      : t("settings.team.notYet");

  function actions(member: PmsStaffMember) {
    const name = member.name || member.email;
    if (member.id === actorMembershipId) return you;
    if (updatingMemberId === member.id)
      return (
        <span
          role="status"
          aria-busy="true"
          aria-label={t("settings.team.savingStatus", { name: member.name || member.email })}
          className="text-xs text-gray-500"
        >
          {t("common.saving")}
        </span>
      );
    if (member.status === "pending")
      return (
        <TeamRowMenu
          label={t("settings.team.moreActionsNamed", { name: member.email })}
          disabled={opening}
          items={[{ label: t("settings.team.resendInvitation"), onSelect: () => onResend(member) }]}
        />
      );
    const busy = opening || updatingMemberId !== null;
    return (
      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onEdit(member)}
          aria-label={t("settings.team.editMemberAccessNamed", { name })}
          title={t("settings.team.editMemberAccess")}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <PencilIcon aria-hidden="true" className="h-4 w-4" />
        </button>
        <TeamRowMenu
          label={t("settings.team.moreActionsNamed", { name })}
          disabled={busy}
          items={[
            {
              label: t(
                member.status === "active"
                  ? "settings.team.suspendAccess"
                  : "settings.team.reactivateAccess",
              ),
              ariaLabel: t(
                member.status === "active"
                  ? "settings.team.deactivateNamed"
                  : "settings.team.reactivateNamed",
                { name },
              ),
              onSelect: () => onToggleStatus(member),
            },
            {
              label: t("settings.team.removeMember"),
              danger: true,
              onSelect: () => onRemove(member),
            },
          ]}
        />
      </div>
    );
  }

  return (
    <TeamSection
      title={t("settings.team.workersHeading")}
      description={t("settings.team.workersDescription")}
    >
      {members.length === 0 ? (
        <div className={`${teamCardClass} flex flex-col items-center gap-2 px-4 py-10 text-center`}>
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-100">
            <UserGroupIcon aria-hidden="true" className="h-5 w-5 text-gray-500" />
          </span>
          <p className="font-semibold text-gray-900">{t("settings.team.empty")}</p>
          <p className="text-sm text-gray-500">{t("settings.team.emptyDescription")}</p>
        </div>
      ) : (
        <div className={teamCardClass}>
          <table
            role="table"
            className="block w-full text-left text-sm xl:table xl:table-fixed xl:border-separate xl:border-spacing-0"
          >
            <colgroup>
              <col className="xl:w-[30%]" />
              <col className="xl:w-[21%]" />
              <col />
              <col className="xl:w-28" />
              <col className="xl:w-28" />
            </colgroup>
            <thead
              role="rowgroup"
              className="block h-px overflow-hidden [clip-path:inset(50%)] xl:table-header-group xl:h-auto xl:overflow-visible xl:[clip-path:none]"
            >
              <tr role="row">
                <th
                  scope="col"
                  role="columnheader"
                  className={`${headClass} rounded-tl-xl xl:px-5`}
                >
                  {t("settings.team.userColumn")}
                </th>
                <th scope="col" role="columnheader" className={headClass}>
                  {t("settings.team.role")}
                </th>
                <th scope="col" role="columnheader" className={headClass}>
                  {t("settings.team.properties")}
                </th>
                <th scope="col" role="columnheader" className={headClass}>
                  {t("bookings.tableStatus")}
                </th>
                <th
                  scope="col"
                  role="columnheader"
                  className={`${headClass} rounded-tr-xl text-right xl:px-5`}
                >
                  {t("settings.team.actions")}
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup" className="block divide-y divide-gray-100 xl:table-row-group">
              {admins.map((admin) => (
                <tr key={admin.membershipId} role="row" className={rowClass}>
                  <td role="cell" className={cell.user}>
                    <p
                      title={admin.name || admin.email}
                      className="truncate font-medium text-gray-900"
                    >
                      {admin.name || admin.email}
                    </p>
                    {admin.name && (
                      <p title={admin.email} className="truncate text-xs text-gray-500">
                        {admin.email}
                      </p>
                    )}
                  </td>
                  <td role="cell" className={cell.role}>
                    <p className="truncate font-medium text-gray-900">
                      {t("settings.team.accountAdmin")}
                    </p>
                  </td>
                  <td role="cell" className={`${cell.properties} truncate text-gray-700`}>
                    {t("settings.team.allProperties")}
                  </td>
                  <td role="cell" className={cell.status}>
                    <StatusBadge status={admin.active ? "active" : "deactivated"} />
                  </td>
                  <td role="cell" className={`${cell.actions} text-right`}>
                    {admin.membershipId === actorMembershipId && you}
                  </td>
                </tr>
              ))}
              {members.map((member) => {
                const suspended = member.status === "deactivated";
                const properties =
                  member.propertyAccessMode === "all"
                    ? t("settings.team.allProperties")
                    : member.propertyIds
                        .map((propertyId) => propertyNames.get(propertyId) ?? propertyId)
                        .join(", ");
                return (
                  <tr key={member.id} role="row" className={rowClass}>
                    <td role="cell" className={cell.user}>
                      <p
                        title={member.name || member.email}
                        className={`truncate font-medium ${suspended ? "text-gray-500" : "text-gray-900"}`}
                      >
                        {member.status === "pending"
                          ? t("settings.team.pendingInvite")
                          : member.name || member.email}
                      </p>
                      {(member.name || member.status === "pending") && (
                        <p title={member.email} className="truncate text-xs text-gray-500">
                          {member.email}
                        </p>
                      )}
                      {feedback?.memberId === member.id && (
                        <p
                          role={feedback.type === "error" ? "alert" : "status"}
                          className={`mt-1 text-xs ${feedback.type === "error" ? "text-red-600" : "text-emerald-700"}`}
                        >
                          {feedback.message}
                        </p>
                      )}
                    </td>
                    <td role="cell" className={cell.role}>
                      <span
                        className={`font-medium ${suspended ? "text-gray-500" : "text-gray-900"}`}
                      >
                        {roleLabel(member)}
                      </span>
                      <span aria-hidden="true" className="text-gray-400 xl:hidden">
                        {" · "}
                      </span>
                      <span className="text-xs text-gray-500 xl:block">
                        {member.status === "pending"
                          ? t("settings.team.invitedNotYetActive")
                          : lastActive(member.lastActiveAt)}
                      </span>
                    </td>
                    <td
                      role="cell"
                      title={
                        member.propertyAccessMode === "all"
                          ? t("settings.team.allFutureProperties")
                          : properties
                      }
                      className={`${cell.properties} truncate ${suspended ? "text-gray-500" : "text-gray-700"}`}
                    >
                      {properties}
                    </td>
                    <td role="cell" className={cell.status}>
                      <StatusBadge status={member.status} />
                    </td>
                    <td role="cell" className={`${cell.actions} text-right`}>
                      {actions(member)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </TeamSection>
  );
}
