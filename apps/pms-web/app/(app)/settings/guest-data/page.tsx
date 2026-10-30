"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon } from "@heroicons/react/24/outline";
import { SettingsSubPage } from "@/components/settings/SettingsSubPage";
import { useTranslation } from "@/lib/i18n";
import {
  guestDataSettingsService,
  type GuestDataField,
  type GuestDataSettings,
  type GuestFieldStatus,
} from "@/services/guests";

const CARD = "bg-white border border-[#E4E7EC] rounded-2xl";
const STATUSES: GuestFieldStatus[] = ["off", "optional", "required"];
const GROUPS: { titleKey: string; fields: (GuestDataField | "firstName" | "lastName")[] }[] = [
  {
    titleKey: "settings.guestData.groupContact",
    fields: ["firstName", "lastName", "email", "phone"],
  },
  {
    titleKey: "settings.guestData.groupIdentity",
    fields: ["nationality", "dateOfBirth", "documentType", "documentNumber"],
  },
];
// Booking engine and New Booking ask these of the lead guest only; the rest of every guest.
const LEAD_GUEST_ONLY: readonly string[] = ["email", "phone"];

/** VAY-2420: Settings › Guest data (Timo's mockup), one per account; changes save at once. */
export default function GuestDataSettingsPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<GuestDataSettings | null>(null);
  const [canManage, setCanManage] = useState(false);
  // A shorter retention waiting for the owner to confirm it.
  const [pendingRetention, setPendingRetention] = useState<7 | 30 | 90 | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "failed" | "loadFailed">("idle");
  // Saves run one after another, so the last change wins; only the latest one sets the status.
  const queue = useRef(Promise.resolve());
  const latest = useRef(0);

  useEffect(() => {
    guestDataSettingsService
      .get()
      .then((loaded) => {
        setSettings(loaded.settings);
        setCanManage(loaded.canManage);
      })
      .catch(() => setState("loadFailed"));
  }, []);

  const change = (next: GuestDataSettings) => {
    setSettings(next);
    setState("saving");
    const save = ++latest.current;
    queue.current = queue.current.then(() =>
      guestDataSettingsService.save(next).then(
        () => save === latest.current && setState("idle"),
        () => save === latest.current && setState("failed"),
      ),
    );
  };

  const fieldLabel = (field: string) => t(`settings.checkIn.field.${field}`);

  return (
    <SettingsSubPage
      title={t("settings.navigation.guestData")}
      description={t("settings.guestData.description")}
      wide
      actions={
        settings && canManage ? (
          <span
            role="status"
            className={`flex items-center gap-1.5 text-[13px] ${
              state === "failed" ? "text-red-600" : "text-[#166534]"
            }`}
          >
            {state === "idle" && <CheckIcon className="w-4 h-4" aria-hidden="true" />}
            {state === "saving"
              ? t("settings.guestData.saving")
              : state === "failed"
                ? t("settings.guestData.saveFailed")
                : t("settings.guestData.autosave")}
            {state === "failed" && (
              <button
                type="button"
                onClick={() => change(settings)}
                className="ml-1 font-semibold text-[#2D3FD3] hover:underline"
              >
                {t("settings.guestData.retry")}
              </button>
            )}
          </span>
        ) : undefined
      }
    >
      {state === "loadFailed" ? (
        <p className="text-sm text-red-600">{t("settings.guestData.loadFailed")}</p>
      ) : !settings ? (
        <p className="text-sm text-gray-400">{t("common.loading")}</p>
      ) : (
        <div className="flex flex-col gap-5">
          {!canManage && (
            <p className="rounded-xl bg-[#F2F4F7] px-4 py-3 text-sm text-[#475467]">
              {t("settings.guestData.ownerOnly")}
            </p>
          )}

          <section className={`${CARD} overflow-hidden`} aria-labelledby="guest-fields">
            <div className="px-6 py-[18px] border-b border-[#EAECF0]">
              <h2 id="guest-fields" className="text-[17px] font-semibold text-[#101828]">
                {t("settings.guestData.fieldsTitle")}
              </h2>
              <p className="mt-0.5 text-[13px] text-[#5B6474]">
                {t("settings.guestData.fieldsDescription")}
              </p>
            </div>
            <div className="overflow-x-auto">
              <div className="min-w-[600px]">
                <div className="grid grid-cols-[minmax(180px,1fr)_140px_minmax(240px,300px)] gap-3 px-6 py-3 bg-[#F9FAFB] border-b border-[#EAECF0] text-xs font-semibold uppercase tracking-[0.04em] text-[#475467]">
                  <span>{t("settings.guestData.columnField")}</span>
                  <span>{t("settings.guestData.columnAppliesTo")}</span>
                  <span>{t("settings.guestData.columnStatus")}</span>
                </div>
                {GROUPS.map((group) => (
                  <div key={group.titleKey}>
                    <div className="px-6 pt-3.5 pb-1.5 text-[13px] font-semibold text-[#101828]">
                      {t(group.titleKey)}
                    </div>
                    {group.fields.map((field) => {
                      const locked = field === "firstName" || field === "lastName";
                      const status: GuestFieldStatus = locked
                        ? "required"
                        : settings.fields[field as GuestDataField];
                      const label = fieldLabel(field);
                      return (
                        <div
                          key={field}
                          className="grid grid-cols-[minmax(180px,1fr)_140px_minmax(240px,300px)] gap-3 items-center px-6 py-2 border-t border-[#F2F4F7]"
                        >
                          <span className="flex items-center gap-2 text-sm text-[#101828]">
                            {label}
                            {locked && (
                              <span className="rounded-md bg-[#F2F4F7] px-1.5 py-px text-[11px] font-semibold text-[#475467]">
                                {t("settings.guestData.always")}
                              </span>
                            )}
                          </span>
                          <span className="text-[13px] text-[#5B6474]">
                            {t(
                              LEAD_GUEST_ONLY.includes(field)
                                ? "settings.guestData.leadGuest"
                                : "settings.guestData.allGuests",
                            )}
                          </span>
                          <div
                            role="radiogroup"
                            aria-label={t("settings.guestData.statusLabel", { field: label })}
                            className="flex max-w-[250px] gap-0.5 rounded-[9px] bg-[#F2F4F7] p-[3px]"
                          >
                            {STATUSES.map((option) => {
                              const selected = option === status;
                              const disabled =
                                !canManage || locked || (field === "email" && option === "off");
                              return (
                                <button
                                  key={option}
                                  type="button"
                                  role="radio"
                                  aria-checked={selected}
                                  disabled={disabled}
                                  onClick={() =>
                                    change({
                                      ...settings,
                                      fields: { ...settings.fields, [field]: option },
                                    })
                                  }
                                  className={`flex-1 rounded-[7px] px-1 py-1.5 text-xs ${
                                    selected
                                      ? option === "required"
                                        ? "bg-[#2D3FD3] text-white font-semibold shadow-sm"
                                        : "bg-white text-[#101828] font-semibold shadow-sm"
                                      : "text-[#475467]"
                                  } ${disabled && !selected ? "opacity-60 cursor-not-allowed" : ""}`}
                                >
                                  {t(`settings.guestData.status.${option}`)}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
                <div className="h-3" />
              </div>
            </div>
          </section>

          <div className="flex flex-wrap items-stretch gap-5">
            <section
              className={`${CARD} flex-[1_1_360px] px-6 py-5`}
              aria-labelledby="guest-matching"
            >
              <h2 id="guest-matching" className="text-[17px] font-semibold text-[#101828]">
                {t("settings.guestData.matchingTitle")}
              </h2>
              <p className="mt-0.5 mb-3.5 text-[13px] text-[#5B6474]">
                {t("settings.guestData.matchingDescription")}
              </p>
              {(["email", "phone"] as const).map((rule) => {
                const on = settings.matching[rule];
                const label = t(`settings.guestData.match.${rule}`);
                return (
                  <div
                    key={rule}
                    className="flex items-center justify-between gap-4 py-2.5 border-t border-[#F2F4F7]"
                  >
                    <span>
                      <span className="block text-sm font-medium text-[#101828]">{label}</span>
                      <span className="block text-xs text-[#5B6474]">
                        {t(`settings.guestData.match.${rule}Hint`)}
                      </span>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={label}
                      disabled={!canManage}
                      onClick={() =>
                        change({ ...settings, matching: { ...settings.matching, [rule]: !on } })
                      }
                      className={`flex w-11 h-[26px] shrink-0 rounded-full p-[3px] disabled:opacity-60 ${
                        on ? "bg-[#2D3FD3] justify-end" : "bg-[#D0D5DD] justify-start"
                      }`}
                    >
                      <span className="w-5 h-5 rounded-full bg-white shadow-sm" />
                    </button>
                  </div>
                );
              })}
            </section>

            <section
              className={`${CARD} flex-[1_1_360px] px-6 py-5`}
              aria-labelledby="identity-retention"
            >
              <h2 id="identity-retention" className="text-[17px] font-semibold text-[#101828]">
                {t("settings.guestData.retentionTitle")}
              </h2>
              <p className="mt-0.5 mb-3.5 text-[13px] text-[#5B6474]">
                {t("settings.guestData.retentionDescription")}
              </p>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-[#101828]">
                {t("settings.guestData.retentionLabel")}
                <select
                  value={pendingRetention ?? settings.identityRetentionDays ?? "keep"}
                  disabled={!canManage}
                  onChange={(event) => {
                    const days =
                      event.target.value === "keep"
                        ? null
                        : (Number(event.target.value) as 7 | 30 | 90);
                    const current = settings.identityRetentionDays;
                    // Deleting sooner removes past guests' documents within the hour: ask first.
                    if (days !== null && (current === null || days < current))
                      setPendingRetention(days);
                    else {
                      setPendingRetention(null);
                      change({ ...settings, identityRetentionDays: days });
                    }
                  }}
                  className="h-11 max-w-[280px] rounded-[10px] border border-[#D0D5DD] bg-white px-3 text-sm font-normal text-[#101828] disabled:bg-gray-50"
                >
                  {[7, 30, 90].map((days) => (
                    <option key={days} value={days}>
                      {t("settings.guestData.retentionDays", { days })}
                    </option>
                  ))}
                  <option value="keep">{t("settings.guestData.retentionKeep")}</option>
                </select>
              </label>
              {pendingRetention !== null && (
                <div
                  role="alert"
                  className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
                >
                  <p>{t("settings.guestData.retentionConfirm", { days: pendingRetention })}</p>
                  <div className="mt-2 flex gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        change({ ...settings, identityRetentionDays: pendingRetention });
                        setPendingRetention(null);
                      }}
                      className="font-semibold text-amber-900 underline"
                    >
                      {t("settings.guestData.retentionConfirmYes", { days: pendingRetention })}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingRetention(null)}
                      className="font-semibold text-[#344054] hover:underline"
                    >
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </SettingsSubPage>
  );
}
