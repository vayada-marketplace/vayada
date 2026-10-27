"use client";

import { useTranslation } from "@/lib/i18n";
import { CheckoutInspectionBuilder } from "@/components/settings/CheckoutInspectionBuilder";
import { SettingsSubPage } from "@/components/settings/SettingsSubPage";
import { useScrollToHash } from "@/components/settings/useScrollToHash";

// The check-out inspection (VAY-2275); the check-in checklist moved to Settings → Check-in (VAY-2374).
export default function GuestFlowsSettingsPage() {
  const { t } = useTranslation();
  useScrollToHash();
  return (
    <SettingsSubPage
      title={t("settings.navigation.guestFlows")}
      description={t("settings.cards.guestFlows.description")}
      wide
    >
      <CheckoutInspectionBuilder />
    </SettingsSubPage>
  );
}
