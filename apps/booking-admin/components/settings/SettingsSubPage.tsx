"use client";

import { SettingsBreadcrumb as SharedSettingsBreadcrumb } from "@vayada/settings-ui";
import { useTranslation } from "@/lib/i18n";
import { PageHeader, PageLayout } from "@/components/layout/PageLayout";

/** Page shell for a Settings card: a breadcrumb back to the card grid and the page title. */
export function SettingsSubPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <PageLayout>
      <div className="max-w-3xl">
        <PageHeader breadcrumb={<SettingsBreadcrumb current={title} />} title={title} />
        {children}
      </div>
    </PageLayout>
  );
}

/**
 * "Settings / … / current page". `fullPageLinks` renders plain anchors for pages whose
 * unsaved-changes guard relies on a full page load (Location & surroundings).
 */
export function SettingsBreadcrumb(props: {
  current: string;
  trail?: { label: string; href: string }[];
  fullPageLinks?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <SharedSettingsBreadcrumb
      settingsLabel={t("settings.title")}
      ariaLabel={t("settings.breadcrumb")}
      {...props}
    />
  );
}
