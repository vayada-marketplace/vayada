"use client";

import { useTranslation } from "@/lib/i18n";
import { OtaCommissionSettingsSection } from "@/components/settings/OtaCommissionSettingsSection";
import { SettingsSubPage } from "@/components/settings/SettingsSubPage";

export default function OtaCommissionsSettingsPage() {
  const { t } = useTranslation();
  return (
    <SettingsSubPage
      title={t("settings.navigation.otaCommissions")}
      description={t("settings.ota.description")}
    >
      <OtaCommissionSettingsSection />
    </SettingsSubPage>
  );
}
