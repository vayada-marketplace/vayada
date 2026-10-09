"use client";

import Link from "next/link";
import { useTranslation } from "@/lib/i18n";

/** Page shell for a Settings card: a breadcrumb back to the card grid and the page title. */
export function SettingsSubPage({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="px-4 py-4 md:px-6 md:py-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <nav aria-label={t("settings.breadcrumb")} className="text-[13px] text-gray-500">
          <ol className="flex items-center gap-1.5">
            <li>
              <Link href="/settings" className="hover:text-gray-900 hover:underline">
                {t("settings.title")}
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="font-medium text-gray-900">
              {title}
            </li>
          </ol>
        </nav>
        <h1 className="mt-2 text-xl font-semibold text-gray-900 md:text-2xl">{title}</h1>
        {children}
      </div>
    </div>
  );
}
