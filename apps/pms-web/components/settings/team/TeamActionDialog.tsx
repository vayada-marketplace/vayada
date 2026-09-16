"use client";
import React from "react";
import Modal from "@/components/Modal";
import { useTranslation } from "@/lib/i18n";
import { useTeamWrite } from "./useTeamWrite";

export type TeamAction = {
  title: string;
  description: string;
  // Construct this action from one captured snapshot; retain it through retries.
  write: (key: string) => Promise<string>;
};
export default function TeamActionDialog({
  action,
  onClose,
  onSaved,
}: {
  action: TeamAction;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { t } = useTranslation();
  const mutation = useTeamWrite();
  async function confirm() {
    let message = "";
    const saved = await mutation.run({}, async (_, key) => {
      message = await action.write(key);
    });
    if (saved) onSaved(message);
  }
  return (
    <Modal
      ariaLabel={action.title}
      onClose={() => {
        if (!mutation.busy) onClose();
      }}
      footer={
        <div className="flex justify-end gap-3">
          <button
            type="button"
            disabled={mutation.busy}
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={mutation.busy}
            onClick={() => void confirm()}
            className="rounded-lg bg-primary-600 px-4 py-2 text-sm text-white"
          >
            {t(mutation.busy ? "common.saving" : "settings.team.confirmAction")}
          </button>
        </div>
      }
    >
      <h2 className="text-lg font-semibold">{action.title}</h2>
      <p className="mt-3 text-sm text-gray-600">{action.description}</p>
      {mutation.error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {mutation.error}
        </p>
      )}
    </Modal>
  );
}
