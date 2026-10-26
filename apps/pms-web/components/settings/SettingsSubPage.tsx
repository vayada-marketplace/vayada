"use client";

import type { ReactNode } from "react";
import { SettingsBreadcrumb } from "@vayada/settings-ui";
import { useTranslation } from "@/lib/i18n";

/**
 * Page shell for a Settings card (VAY-2275): "Settings / <card>" back to the card grid, the page
 * title with an optional summary and actions, then the page's sections.
 */
export function SettingsSubPage({
  title,
  breadcrumb = title,
  description,
  actions,
  wide = false,
  children,
}: {
  title: string;
  /** The card's name, when the title says more. */
  breadcrumb?: string;
  description?: string;
  actions?: ReactNode;
  /** Editors with a side panel (Guest flows) need more than the reading width. */
  wide?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="p-4 md:p-6">
      <div className={wide ? "max-w-6xl" : "max-w-3xl"}>
        <SettingsBreadcrumb
          settingsLabel={t("settings.title")}
          ariaLabel={t("settings.breadcrumb")}
          current={breadcrumb}
          className="mb-2"
        />
        <div className="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0 flex-[1_1_14rem]">
            <h1 className="text-xl font-semibold text-gray-900 md:text-2xl">{title}</h1>
            {description && <p className="mt-1 text-[13px] text-gray-500">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
        {/* Own wrapper, so the first SettingsSection drops its top padding (first:pt-0). */}
        <div>{children}</div>
      </div>
    </div>
  );
}
