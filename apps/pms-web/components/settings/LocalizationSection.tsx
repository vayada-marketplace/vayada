"use client";

import { SettingsSection, SettingsCard } from "./layout";
import { CurrencySelect } from "./CurrencySelect";
import { useTranslation, SUPPORTED_LANGUAGES } from "@/lib/i18n";

interface LocalizationSectionProps {
  currency: string;
  setCurrency: (v: string) => void;
  savingCurrency: boolean;
  onSaveCurrency: () => void;
}

export function LocalizationSection({
  currency,
  setCurrency,
  savingCurrency,
  onSaveCurrency,
}: LocalizationSectionProps) {
  const { t, locale, setLocale } = useTranslation();

  return (
    <SettingsSection
      id="localization"
      title="Localization"
      description="Default currency and interface language."
    >
      <SettingsCard
        title={t("settings.currency")}
        description={t("settings.currencyDescription")}
        footer={
          <div className="flex justify-end">
            <button
              onClick={onSaveCurrency}
              disabled={savingCurrency}
              className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {savingCurrency ? t("common.saving") : t("common.save")}
            </button>
          </div>
        }
      >
        <div id="currency" className="scroll-mt-24">
          <CurrencySelect value={currency} onChange={setCurrency} t={t} />
        </div>
      </SettingsCard>

      <SettingsCard
        title={t("settings.language")}
        description={t("settings.languageDescription")}
      >
        <div id="language" className="scroll-mt-24 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
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
