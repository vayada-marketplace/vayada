"use client";

import { useTranslation } from "@/lib/i18n";
import { CheckinChecklistBuilder } from "@/components/settings/CheckinChecklistBuilder";
import { CheckoutInspectionBuilder } from "@/components/settings/CheckoutInspectionBuilder";
import { SettingsSubPage } from "@/components/settings/SettingsSubPage";
import { useScrollToHash } from "@/components/settings/useScrollToHash";

// The check-in checklist and the check-out inspection, each with its own Save (VAY-2275).
export default function GuestFlowsSettingsPage() {
  const { t } = useTranslation();
  useScrollToHash();
  return (
    <SettingsSubPage
      title={t("settings.navigation.guestFlows")}
      description={t("settings.cards.guestFlows.description")}
      wide
    >
      <CheckinChecklistBuilder />
      <CheckoutInspectionBuilder />
    </SettingsSubPage>
  );
}
