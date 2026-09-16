"use client";
import React from "react";
import { useTranslation } from "@/lib/i18n";
import type { PmsAccountAdmin } from "@/services/api/pmsStaffClient";

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
    <section
      aria-label={t("settings.team.accountAdmin")}
      className="rounded-xl border border-gray-200 bg-white p-5"
    >
      <h2 className="text-lg font-semibold text-gray-900">{t("settings.team.accountAdmin")}</h2>
      <p className="mt-1 text-sm text-gray-500">{t("settings.team.accountAdminDescription")}</p>
      {needsReview && (
        <p role="status" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {t("settings.team.adminNeedsReview")}
        </p>
      )}
      {admins.map((admin) => (
        <div key={admin.membershipId} className="mt-4 flex items-center gap-3">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-50 text-sm font-semibold text-primary-700"
          >
            {(admin.name || admin.email).trim().slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="break-words font-medium text-gray-900">{admin.name || admin.email}</p>
            <p className="break-words text-sm text-gray-500">{admin.email}</p>
          </div>
          <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-700">
            {t(admin.active ? "settings.team.accountAdmin" : "settings.team.accessSuspended")}
          </span>
          {canTransfer && onTransfer && (
            <button
              type="button"
              onClick={onTransfer}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700"
            >
              {t("settings.team.transferAdmin")}
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
