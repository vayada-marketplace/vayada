"use client";

import { useState } from "react";
import { SettingsSection, SettingsCard } from "@vayada/settings-ui";
import { useTranslation, SUPPORTED_LANGUAGES } from "@/lib/i18n";
import { useHasPmsPermission } from "@/lib/settings/PmsAccessContext";
import { ChangeCurrencyDialog } from "./ChangeCurrencyDialog";

interface LocalizationSectionProps {
  currency: string;
  currencyLoadError: string;
  currencyLoadStatus: "loading" | "ready" | "error";
  /** VAY-2390 P5: after the Owner's change, so the page shows the new currency. */
  onCurrencyChanged?: (currency: string) => void;
}

export function LocalizationSection({
  currency,
  currencyLoadError,
  currencyLoadStatus,
  onCurrencyChanged,
}: LocalizationSectionProps) {
  const { t, locale, setLocale } = useTranslation();
  // Only Owners hold this key (VAY-2401); the change route checks the same one.
  const canChange = useHasPmsPermission("finance.billing.manage");
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState("");
  const name = (code: string) => {
    try {
      return new Intl.DisplayNames([locale], { type: "currency" }).of(code) ?? code;
    } catch {
      return code;
    }
  };

  return (
    <SettingsSection
      id="localization"
      title={t("settings.localization.title")}
      description={t("settings.localization.description")}
    >
      <SettingsCard title={t("settings.currency")} description={t("settings.currencyDescription")}>
        <div id="currency" className="scroll-mt-24">
          {currencyLoadStatus === "error" ? (
            <p className="text-sm text-red-600" role="alert">
              {currencyLoadError || t("settings.localization.currencyLoadError")}
            </p>
          ) : currencyLoadStatus === "loading" ? (
            <p className="text-sm text-gray-500" role="status">
              {t("settings.localization.loadingCurrency")}
            </p>
          ) : currency ? (
            <div className="flex flex-col gap-3 rounded-lg border border-gray-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900">
                  {currency} · {name(currency)}
                </p>
                <p className="mt-0.5 text-sm text-gray-600">
                  {t("settings.currencyChange.rowBody", { currency })}
                </p>
              </div>
              {canChange && (
                <button
                  type="button"
                  onClick={() => {
                    setChanged("");
                    setChanging(true);
                  }}
                  className="shrink-0 self-start rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:self-auto"
                >
                  {t("settings.currencyChange.changeButton")}
                </button>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500" role="status">
              {t("settings.localization.noCurrency")}
            </p>
          )}
        </div>
        {changed && (
          <p role="status" className="mt-3 text-sm text-green-700">
            {t("settings.currencyChange.changed", { code: changed })}
          </p>
        )}
        {changing && (
          <ChangeCurrencyDialog
            onClose={() => setChanging(false)}
            onChanged={(next) => {
              setChanging(false);
              setChanged(next);
              onCurrencyChanged?.(next);
            }}
          />
        )}
      </SettingsCard>

      <SettingsCard title={t("settings.language")} description={t("settings.languageDescription")}>
        <div
          id="language"
          className="scroll-mt-24 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2"
        >
          {SUPPORTED_LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              type="button"
              onClick={() => setLocale(lang.code)}
              className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors ${
                locale === lang.code
                  ? "bg-primary-50 border-primary-300 text-primary-700 font-medium"
                  : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"
              }`}
            >
              <span>{lang.flag}</span>
              <span className="truncate">{lang.nativeName}</span>
            </button>
          ))}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
