"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AdjustmentsHorizontalIcon,
  ArrowRightIcon,
  BoltIcon,
  Cog6ToothIcon,
  CreditCardIcon,
  DocumentTextIcon,
  EnvelopeIcon,
  GiftIcon,
  ReceiptPercentIcon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { legacySettingsPageUrl } from "@/lib/utils/settingsSectionUrl";

type SettingsCardLink = {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  // Cards without a page have no backend yet (VAY-2095, VAY-2096).
  href?: string;
};

const FEATURE_HUB = {
  title: "layout.sidebar.featureHub",
  description: "settings.cards.featureHub.description",
  icon: BoltIcon,
  href: "/settings/feature-hub",
} satisfies SettingsCardLink;

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
    title: "settings.cards.email.title",
    description: "settings.cards.email.description",
    icon: EnvelopeIcon,
  },
  {
    title: "settings.cards.account.title",
    description: "settings.cards.account.description",
    icon: UserCircleIcon,
  },
  {
    title: "settings.tabs.billing",
    description: "settings.cards.billing.description",
    icon: ReceiptPercentIcon,
    href: "/settings/billing",
  },
];

function CardBody({ card, wide = false }: { card: SettingsCardLink; wide?: boolean }) {
  const { t } = useTranslation();
  const Icon = card.icon;
  return (
    <>
      <span className="flex items-center gap-4">
        <span
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
            wide ? "bg-white text-primary-600" : "bg-primary-50 text-primary-600",
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
        <span className="text-[15px] font-semibold text-gray-900">{t(card.title)}</span>
      </span>
      <span className="mt-4 block flex-1 text-[13px] leading-5 text-gray-600">
        {t(card.description)}
      </span>
      {card.href ? (
        <span className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-primary-600">
          {t("settings.index.open")}
          <ArrowRightIcon className="h-3.5 w-3.5" />
        </span>
      ) : (
        <span className="mt-4 inline-flex w-fit rounded-full bg-gray-100 px-2.5 py-0.5 text-[11px] font-medium text-gray-600">
          {t("settings.index.comingSoon")}
        </span>
      )}
    </>
  );
}

const cardClass = "flex h-full flex-col rounded-2xl border bg-white p-5 transition-colors md:p-6";

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

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 lg:px-8 lg:py-8">
      <h1 className="text-xl font-semibold text-gray-900 md:text-2xl">
        {t("settings.index.title")}
      </h1>
      <Link
        href={FEATURE_HUB.href}
        className={cn(
          cardClass,
          "mt-6 border-primary-200 bg-primary-50/60 hover:border-primary-300 hover:bg-primary-50",
        )}
      >
        <CardBody card={FEATURE_HUB} wide />
      </Link>
      <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((card) => (
          <li key={card.title}>
            {card.href ? (
              <Link
                href={card.href}
                className={cn(
                  cardClass,
                  "border-gray-200 hover:border-primary-200 hover:bg-primary-50/40",
                )}
              >
                <CardBody card={card} />
              </Link>
            ) : (
              <div aria-disabled="true" className={cn(cardClass, "border-gray-200 opacity-70")}>
                <CardBody card={card} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
