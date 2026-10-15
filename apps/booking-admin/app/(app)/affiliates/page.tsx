"use client";

import Link from "next/link";
import { useTranslation } from "@/lib/i18n";
import { PageHeader, PageLayout } from "@/components/layout/PageLayout";

export default function AffiliatesPage() {
  const { t } = useTranslation();
  return (
    <PageLayout>
      <section className="max-w-3xl space-y-4">
        <PageHeader title={t("admin.affiliateManagementIsUnavailable")} />
        <Link href="/" className="block w-fit text-sm font-medium text-primary-700 underline">
          {t("layout.sidebar.dashboard")}
        </Link>
      </section>
    </PageLayout>
  );
}
