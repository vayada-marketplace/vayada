"use client";

import { SettingsBreadcrumb as SharedSettingsBreadcrumb } from "@vayada/settings-ui";
import { useTranslation } from "@/lib/i18n";
import { PageHeader, PageLayout } from "@/components/layout/PageLayout";

/** Page shell for a Settings card: a breadcrumb back to the card grid and the page title. `wide` leaves room
 * for a preview next to the form (Room Sorting, VAY-2449). */
export function SettingsSubPage({
  title,
  children,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <PageLayout>
      <div className={wide ? "max-w-6xl" : "max-w-3xl"}>
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
