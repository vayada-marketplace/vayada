"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AdjustmentsHorizontalIcon,
  BoltIcon,
  ClipboardDocumentListIcon,
  Cog6ToothIcon,
  CreditCardIcon,
  DocumentTextIcon,
  FunnelIcon,
  GiftIcon,
  ReceiptPercentIcon,
  ShieldCheckIcon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";
import { SettingsCardGrid, type SettingsCardLink } from "@vayada/settings-ui";
import { useTranslation } from "@/lib/i18n";
import { PageHeader, PageLayout } from "@/components/layout/PageLayout";
import { legacySettingsPageUrl } from "@/lib/utils/settingsSectionUrl";

// Titles and descriptions are translation keys. Cards without a page have no backend yet
// (VAY-2095, VAY-2096).
const FEATURE_HUB = {
  title: "layout.sidebar.featureHub",
  description: "settings.cards.featureHub.description",
  icon: BoltIcon,
  href: "/settings/feature-hub",
} satisfies SettingsCardLink;

// Timo's order (VAY-2144). Email & notifications stays hidden until it has a page.
const CARDS: SettingsCardLink[] = [
  {
    title: "settings.cards.bookingRules.title",
    description: "settings.cards.bookingRules.description",
    icon: AdjustmentsHorizontalIcon,
    href: "/settings/booking-rules",
  },
  {
    title: "settings.cards.general.title",
    description: "settings.cards.general.description",
    icon: Cog6ToothIcon,
    href: "/settings/general",
  },
  {
    title: "admin.payments",
    description: "settings.cards.payments.description",
    icon: CreditCardIcon,
    href: "/settings/payments",
  },
  {
    title: "settings.cards.benefits.title",
    description: "settings.cards.benefits.description",
    icon: GiftIcon,
    href: "/settings/book-direct-benefits",
  },
  {
    title: "settings.cards.policies.title",
    description: "settings.cards.policies.description",
    icon: DocumentTextIcon,
    href: "/settings/policies",
  },
  {
    title: "settings.cards.roomFilters.title",
    description: "settings.cards.roomFilters.description",
    icon: FunnelIcon,
    href: "/settings/room-filters",
  },
  {
    title: "settings.cards.guestForm.title",
    description: "settings.cards.guestForm.description",
    icon: ClipboardDocumentListIcon,
    href: "/settings/guest-form",
  },
  {
    title: "settings.tabs.billing",
    description: "settings.cards.billing.description",
    icon: ReceiptPercentIcon,
    href: "/settings/billing",
  },
  {
    title: "settings.cards.privacy.title",
    description: "settings.cards.privacy.description",
    icon: ShieldCheckIcon,
    href: "/settings/privacy",
  },
  {
    title: "settings.cards.account.title",
    description: "settings.cards.account.description",
    icon: UserCircleIcon,
  },
];

export function SettingsIndex() {
  const { t } = useTranslation();
  const router = useRouter();
  const [legacyChecked, setLegacyChecked] = useState(false);

  useEffect(() => {
    const target = legacySettingsPageUrl(window.location.search, window.location.hash);
    if (target) router.replace(target);
    else setLegacyChecked(true);
  }, [router]);

  if (!legacyChecked) return null;

  const translate = <T extends SettingsCardLink>(card: T): T => ({
    ...card,
    title: t(card.title),
    description: t(card.description),
  });

  return (
    <PageLayout>
      <PageHeader title={t("settings.index.title")} />
      <SettingsCardGrid
        featured={translate(FEATURE_HUB)}
        cards={CARDS.map(translate)}
        openLabel={t("settings.index.open")}
        comingSoonLabel={t("settings.index.comingSoon")}
      />
    </PageLayout>
  );
}
