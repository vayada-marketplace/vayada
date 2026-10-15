"use client";

import { Fragment } from "react";
import Link from "next/link";
import { useTranslation } from "@/lib/i18n";
import { PageLayout } from "@/components/layout/PageLayout";

/** Page shell for a Settings card: a breadcrumb back to the card grid and the page title. */
export function SettingsSubPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <PageLayout>
      <div className="max-w-3xl">
        <SettingsBreadcrumb current={title} />
        <h1 className="mt-2 text-xl font-semibold text-gray-900 md:text-2xl">{title}</h1>
        {children}
      </div>
    </PageLayout>
  );
}

/**
 * "Settings / … / current page". `fullPageLinks` renders plain anchors for pages whose
 * unsaved-changes guard relies on a full page load (Location & surroundings).
 */
export function SettingsBreadcrumb({
  current,
  trail = [],
  fullPageLinks = false,
  className,
}: {
  current: string;
  trail?: { label: string; href: string }[];
  fullPageLinks?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const crumbs = [{ label: t("settings.title"), href: "/settings" }, ...trail];
  const linkClass = "hover:text-gray-900 hover:underline";
  return (
    <nav aria-label={t("settings.breadcrumb")} className={className}>
      <ol className="flex items-center gap-1.5 text-[13px] text-gray-500">
        {crumbs.map((crumb) => (
          <Fragment key={crumb.href}>
            <li>
              {fullPageLinks ? (
                <a href={crumb.href} className={linkClass}>
                  {crumb.label}
                </a>
              ) : (
                <Link href={crumb.href} className={linkClass}>
                  {crumb.label}
                </Link>
              )}
            </li>
            <li aria-hidden="true">/</li>
          </Fragment>
        ))}
        <li aria-current="page" className="font-medium text-gray-900">
          {current}
        </li>
      </ol>
    </nav>
  );
}
