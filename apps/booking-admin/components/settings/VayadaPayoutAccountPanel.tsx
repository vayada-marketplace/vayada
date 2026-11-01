"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FeedbackAlert } from "@/components/ui";
import { useTranslation } from "@/lib/i18n";
import {
  activePayoutDestination,
  PAYOUT_COUNTRIES,
  payoutDetailsValid,
  readPayoutDestination,
  removePayoutDestination,
  savePayoutDestination,
  type PayoutDestinationDetails,
  type SavedPayoutDestination,
} from "@/services/api/financePayoutDestinationClient";

const EMPTY: PayoutDestinationDetails = {
  accountHolder: "",
  accountNumber: "",
  bankName: "",
  bankCode: "",
  branchCode: "",
  bicSwift: "",
  holderAddress: "",
};
const inputClass =
  "w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500";
const labelClass = "block text-[12px] font-medium text-gray-700 mb-0.5";
type Message = { type: "success" | "error"; key: string };

/** vayada Payment (VAY-2442 P6): how it works and the bank account Vayada pays the hotel out to.
 * The account saves on its own (owner only), apart from the page's Save: adding it is what lets
 * Vayada check the account and switch card payments on; removing it withdraws that approval. */
export function VayadaPayoutAccountPanel({
  propertyId,
  feePercent,
  canEdit,
  onAccountChange,
}: {
  propertyId: string;
  feePercent: number | null;
  canEdit: boolean;
  /** Whether a payout account is saved, once known (the page's card banner uses it). */
  onAccountChange?: (saved: boolean) => void;
}) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<SavedPayoutDestination | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "failed">("loading");
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [countryCode, setCountryCode] = useState<string>("ID");
  const [details, setDetails] = useState<PayoutDestinationDetails>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  // The same save or removal, retried, keeps its command id (a lost response then replays).
  const attempt = useRef<{ fingerprint: string; commandId: string } | null>(null);
  const reported = useRef(onAccountChange);
  useEffect(() => {
    reported.current = onAccountChange;
  }, [onAccountChange]);

  const apply = useCallback((destination: SavedPayoutDestination | null) => {
    setSaved(destination);
    reported.current?.(activePayoutDestination(destination) !== null);
  }, []);
  const load = useCallback(() => {
    let cancelled = false;
    setLoadState("loading");
    readPayoutDestination(propertyId)
      .then((destination) => {
        if (cancelled) return;
        apply(destination);
        setEditing(activePayoutDestination(destination) === null);
        setLoadState("loaded");
      })
      .catch(() => {
        if (!cancelled) setLoadState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId, apply]);
  useEffect(load, [load]);

  const active = activePayoutDestination(saved);
  const commandFor = (fingerprint: string) => {
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, commandId: crypto.randomUUID() };
    return attempt.current.commandId;
  };
  const failed = (error: unknown) => {
    const code = (error as { data?: { code?: unknown } })?.data?.code;
    setMessage({
      type: "error",
      key:
        code === "destination_conflict"
          ? "settings.billing.vayadaPayout.conflict"
          : "settings.billing.vayadaPayout.saveError",
    });
  };
  const save = async () => {
    if (!payoutDetailsValid(countryCode, details)) {
      setMessage({ type: "error", key: "settings.billing.vayadaPayout.invalid" });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const commandId = commandFor(
        JSON.stringify(["replace", saved?.version ?? 0, countryCode, details]),
      );
      apply(await savePayoutDestination({ propertyId, commandId, countryCode, details, saved }));
      attempt.current = null;
      setDetails(EMPTY);
      setEditing(false);
      setMessage({ type: "success", key: "settings.billing.vayadaPayout.savedToast" });
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!active) return;
    setBusy(true);
    setMessage(null);
    try {
      const commandId = commandFor(JSON.stringify(["delete", active.version]));
      apply(await removePayoutDestination({ propertyId, commandId, saved: active }));
      attempt.current = null;
      setConfirmRemove(false);
      setEditing(true);
      setMessage({ type: "success", key: "settings.billing.vayadaPayout.removedToast" });
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };
  const countryName = (code: string) =>
    code === "LK"
      ? t("settings.billing.vayadaPayout.countryLK")
      : code === "ID"
        ? t("settings.billing.vayadaPayout.countryID")
        : code;
  const field = (key: keyof PayoutDestinationDetails, label: string, maxLength: number) => (
    <div>
      <label className={labelClass} htmlFor={`vayada-payout-${key}`}>
        {label}
      </label>
      <input
        id={`vayada-payout-${key}`}
        type="text"
        maxLength={maxLength}
        value={details[key]}
        onChange={(event) => setDetails({ ...details, [key]: event.target.value })}
        autoComplete="off"
        className={inputClass}
      />
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-[12px] text-gray-700 space-y-1">
        <p>{t("settings.billing.vayadaPayout.intro")}</p>
        <p>
          {feePercent === null
            ? t("settings.billing.vayadaPayout.feeNoPercent")
            : t("settings.billing.vayadaPayout.fee", { percent: String(feePercent) })}
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 px-4 py-3">
        <p className="text-[13px] font-semibold text-gray-900">
          {t("settings.billing.vayadaPayout.accountTitle")}
        </p>
        {message && <FeedbackAlert type={message.type} message={t(message.key)} className="mt-2" />}
        {loadState === "loading" ? (
          <div className="mt-2 h-9 animate-pulse rounded-lg bg-gray-100" />
        ) : loadState === "failed" ? (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12px] text-red-700">
              {t("settings.billing.vayadaPayout.loadError")}
            </p>
            <button
              type="button"
              onClick={load}
              className="px-3 py-1.5 text-[12px] font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              {t("settings.billing.vayadaPayout.retry")}
            </button>
          </div>
        ) : active && !editing ? (
          <div className="mt-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] text-gray-800">
                {t("settings.billing.vayadaPayout.savedAccount", {
                  country: countryName(active.countryCode),
                  account: active.maskedAccount ?? "",
                })}
              </p>
              {canEdit && !confirmRemove && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setCountryCode(active.countryCode);
                      setEditing(true);
                      setMessage(null);
                    }}
                    className="px-3 py-1.5 text-[12px] font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                  >
                    {t("settings.billing.vayadaPayout.change")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(true)}
                    className="px-3 py-1.5 text-[12px] font-medium rounded-lg border border-red-200 text-red-700 hover:bg-red-50"
                  >
                    {t("settings.billing.vayadaPayout.remove")}
                  </button>
                </div>
              )}
            </div>
            {confirmRemove && (
              <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5">
                <p className="text-[12px] text-red-800">
                  {t("settings.billing.vayadaPayout.removeConfirm")}
                </p>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(false)}
                    className="px-3 py-1.5 text-[12px] font-medium rounded-lg border border-gray-300 bg-white text-gray-700"
                  >
                    {t("settings.billing.vayadaPayout.cancel")}
                  </button>
                  <button
                    type="button"
                    onClick={remove}
                    disabled={busy}
                    className="px-3 py-1.5 text-[12px] font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {t("settings.billing.vayadaPayout.remove")}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : !canEdit ? (
          <p className="mt-2 text-[12px] text-gray-600">
            {t("settings.billing.vayadaPayout.ownerOnly")}
          </p>
        ) : (
          <div className="mt-2 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={labelClass} htmlFor="vayada-payout-country">
                  {t("settings.billing.vayadaPayout.country")}
                </label>
                <select
                  id="vayada-payout-country"
                  value={countryCode}
                  onChange={(event) => setCountryCode(event.target.value)}
                  className={inputClass}
                >
                  {PAYOUT_COUNTRIES.map((code) => (
                    <option key={code} value={code}>
                      {countryName(code)}
                    </option>
                  ))}
                </select>
              </div>
              {field("accountHolder", t("settings.billing.vayadaPayout.holder"), 200)}
              {field("accountNumber", t("settings.billing.vayadaPayout.number"), 64)}
              {field("bankName", t("settings.billing.vayadaPayout.bank"), 200)}
              {countryCode === "LK"
                ? field("branchCode", t("settings.billing.vayadaPayout.branchCode"), 32)
                : field("bankCode", t("settings.billing.vayadaPayout.bankCode"), 32)}
              {field("bicSwift", t("settings.billing.vayadaPayout.swift"), 32)}
            </div>
            {field("holderAddress", t("settings.billing.vayadaPayout.address"), 500)}
            <p className="text-[11px] text-gray-500">
              {active
                ? t("settings.billing.vayadaPayout.changeNote")
                : t("settings.billing.vayadaPayout.checkNote")}
            </p>
            <div className="flex justify-end gap-2">
              {active && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDetails(EMPTY);
                    setMessage(null);
                  }}
                  className="px-3 py-1.5 text-[13px] font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                >
                  {t("settings.billing.vayadaPayout.cancel")}
                </button>
              )}
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="px-3 py-1.5 text-[13px] font-medium rounded-lg bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50"
              >
                {busy
                  ? t("settings.billing.vayadaPayout.saving")
                  : t("settings.billing.vayadaPayout.save")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
