"use client";

import { Fragment } from "react";
import Link from "next/link";

interface SettingsBreadcrumbProps {
  /** "Settings", translated. */
  settingsLabel: string;
  /** The nav landmark's accessible name, translated. */
  ariaLabel: string;
  current: string;
  trail?: { label: string; href: string }[];
  /**
   * Plain anchors instead of client-side links, for pages whose unsaved-changes guard relies on
   * a full page load.
   */
  fullPageLinks?: boolean;
  className?: string;
}

/** "Settings / … / current page" above a Settings sub-page's title. */
export function SettingsBreadcrumb({
  settingsLabel,
  ariaLabel,
  current,
  trail = [],
  fullPageLinks = false,
  className,
}: SettingsBreadcrumbProps) {
  const crumbs = [{ label: settingsLabel, href: "/settings" }, ...trail];
  const linkClass = "hover:text-gray-900 hover:underline";
  return (
    <nav aria-label={ariaLabel} className={className}>
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
