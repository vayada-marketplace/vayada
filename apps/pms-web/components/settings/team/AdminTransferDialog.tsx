"use client";

import { useMemo, useState } from "react";
import Modal from "@/components/Modal";
import { useTranslation } from "@/lib/i18n";
import { startAdminTransfer } from "@/services/auth/adminTransfer";
import {
  getPmsAccountAdmins,
  getPmsStaffAccess,
  type PmsStaffMember,
  type PmsTeamRole,
} from "@/services/api/pmsStaffClient";

export default function AdminTransferDialog({
  actorMembershipId,
  members,
  roles,
  onClose,
}: {
  actorMembershipId: string;
  members: PmsStaffMember[];
  roles: PmsTeamRole[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const candidates = useMemo(
    () => members.filter((member) => member.status === "active" && member.id !== actorMembershipId),
    [actorMembershipId, members],
  );
  const formerRoles = useMemo(
    () => roles.filter((role) => ["staff", "housekeeping"].includes(role.securityClass)),
    [roles],
  );
  const defaultRole = formerRoles.find((role) => role.presetKey === "agency_manager")?.id ?? "";
  const [targetMembershipId, setTargetMembershipId] = useState("");
  const [formerRoleId, setFormerRoleId] = useState(defaultRole);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedRole = formerRoles.find((role) => role.id === formerRoleId);

  async function start() {
    if (!targetMembershipId || !selectedRole || busy) return;
    setBusy(true);
    setError("");
    try {
      const [account, target] = await Promise.all([
        getPmsAccountAdmins(),
        getPmsStaffAccess(targetMembershipId),
      ]);
      const actor = account.admins.find(
        (admin) =>
          account.actorMembershipId === actorMembershipId &&
          admin.membershipId === actorMembershipId &&
          admin.active &&
          admin.roleKey === "hotel_owner",
      );
      if (!actor) throw new Error("Account admin changed");
      await startAdminTransfer({
        targetMembershipId,
        expectedActorRevision: actor.revision,
        expectedTargetRevision: target.revision,
        formerAdmin: {
          roleDefinitionId: selectedRole.id,
          expectedRoleRevision: selectedRole.revision,
          propertyAccessMode: "all",
          propertyIds: [],
          permissionOverrides: { grant: [], deny: [] },
          productAccess: { pms: true, booking: true },
        },
      });
    } catch {
      setError(t("settings.team.adminTransferError"));
      setBusy(false);
    }
  }

  return (
    <Modal
      ariaLabel={t("settings.team.transferAdmin")}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className="flex justify-end gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={busy || !targetMembershipId || !selectedRole}
            onClick={() => void start()}
            className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {t(busy ? "settings.team.adminTransferRedirecting" : "settings.team.continueSecurely")}
          </button>
        </div>
      }
    >
      <h2 className="text-lg font-semibold text-gray-900">{t("settings.team.transferAdmin")}</h2>
      <p className="mt-2 text-sm text-gray-600">{t("settings.team.adminTransferDescription")}</p>
      {error && (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}
      {candidates.length === 0 ? (
        <p role="status" className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {t("settings.team.adminTransferNoCandidates")}
        </p>
      ) : (
        <div className="mt-5 space-y-4">
          <label className="block text-sm font-medium text-gray-900">
            {t("settings.team.newAccountAdmin")}
            <select
              value={targetMembershipId}
              disabled={busy}
              onChange={(event) => setTargetMembershipId(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-300 p-2"
            >
              <option value="">{t("settings.team.selectNewAccountAdmin")}</option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name || candidate.email} · {candidate.email}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-gray-900">
            {t("settings.team.yourRoleAfterTransfer")}
            <select
              value={formerRoleId}
              disabled={busy}
              onChange={(event) => setFormerRoleId(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-300 p-2"
            >
              <option value="">{t("settings.team.selectRole")}</option>
              {formerRoles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </label>
          <p className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600">
            {t("settings.team.adminTransferAccessSummary")}
          </p>
          <p className="text-sm text-gray-600">{t("settings.team.adminTransferReauth")}</p>
        </div>
      )}
    </Modal>
  );
}
