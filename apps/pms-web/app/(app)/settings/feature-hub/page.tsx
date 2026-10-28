"use client";

import { FeatureHubPage } from "@vayada/feature-hub";
import { SettingsBreadcrumb } from "@vayada/settings-ui";
import { pageTitleClassName } from "@/components/layout/PageHeader";
import { useTranslation } from "@/lib/i18n";
import { moduleActivationClient } from "@/services/api/moduleActivationClient";

export default function PmsFeatureHubRoute() {
  const { t } = useTranslation();
  return (
    <FeatureHubPage
      activationClient={moduleActivationClient}
      titleClassName={pageTitleClassName}
      breadcrumb={
        <SettingsBreadcrumb
          settingsLabel={t("settings.title")}
          ariaLabel={t("settings.breadcrumb")}
          current={t("layout.sidebar.featureHub")}
          className="mb-2"
        />
      }
    />
  );
}
