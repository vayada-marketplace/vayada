"use client";
import React from "react";
import { ShieldCheckIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";
import type { PmsAccountAdmin } from "@/services/api/pmsStaffClient";
import TeamSection, { teamCardClass } from "./TeamSection";

// "Anna Weber" -> "AW"; a single word or an email keeps its first two letters.
function initials(label: string) {
  const words = label.trim().split(/\s+/);
  const letters = words.length > 1 ? words[0]![0]! + words.at(-1)![0]! : label.trim().slice(0, 2);
  return letters.toUpperCase();
}

export default function AccountAdminCard({
  admins,
  canTransfer,
  onTransfer,
}: {
  admins: PmsAccountAdmin[];
  canTransfer?: boolean;
  onTransfer?: () => void;
}) {
  const { t } = useTranslation();
  const needsReview =
    admins.length !== 1 || admins.some((admin) => !admin.active || admin.roleKey !== "hotel_owner");
  return (
    <TeamSection
      title={t("settings.team.accountAdmin")}
      description={t("settings.team.accountAdminDescription")}
    >
      <div className={`${teamCardClass} space-y-4 p-5`}>
        {needsReview && (
          <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            {t("settings.team.adminNeedsReview")}
          </p>
        )}
        {admins.map((admin) => (
          <div key={admin.membershipId} className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-50 text-sm font-semibold text-primary-700"
              >
                {initials(admin.name || admin.email)}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="break-words font-semibold text-gray-900">
                    {admin.name || admin.email}
                  </p>
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${admin.active ? "bg-primary-50 text-primary-700" : "bg-gray-100 text-gray-600"}`}
                  >
                    {admin.active && <ShieldCheckIcon aria-hidden="true" className="h-3.5 w-3.5" />}
                    {t(admin.active ? "settings.team.adminBadge" : "settings.team.accessSuspended")}
                  </span>
                </div>
                <p className="break-words text-sm text-gray-500">
                  {admin.email} · {t("settings.team.fullAccess")}
                </p>
              </div>
            </div>
            {canTransfer && onTransfer && (
              <button
                type="button"
                onClick={onTransfer}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:shrink-0"
              >
                {t("settings.team.transferAdmin")}
              </button>
            )}
          </div>
        ))}
      </div>
    </TeamSection>
  );
}
