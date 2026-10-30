import {
  BoltIcon,
  CalendarDaysIcon,
  ClipboardDocumentCheckIcon,
  CreditCardIcon,
  IdentificationIcon,
  KeyIcon,
  ReceiptPercentIcon,
  UserCircleIcon,
  UserGroupIcon,
} from "@heroicons/react/24/outline";
import { HotelIcon } from "@vayada/product-onboarding";
import type { SettingsCardLink } from "@vayada/settings-ui";
import type { PmsSelfAccess } from "@/services/api/pmsStaffClient";

type PmsSettingsCard = SettingsCardLink & { id: string };

/** The Settings card grid (VAY-2275): Feature Hub on top, then the cards this role may open. */
export function getPmsSettingsCards(
  t: (key: string) => string,
  access?: PmsSelfAccess,
): { featured: SettingsCardLink & { href: string }; cards: PmsSettingsCard[] } {
  const card = (id: string, titleKey: string, icon: PmsSettingsCard["icon"], href?: string) => ({
    id,
    title: t(titleKey),
    description: t(`settings.cards.${id}.description`),
    icon,
    href,
  });
  const cards: PmsSettingsCard[] = [
    card("property", "settings.navigation.property", HotelIcon, "/settings/property"),
    card("calendar", "settings.navigation.calendar", CalendarDaysIcon, "/settings/calendar"),
    card("checkIn", "settings.navigation.checkIn", KeyIcon, "/settings/check-in"),
    card("guestData", "settings.navigation.guestData", IdentificationIcon, "/settings/guest-data"),
    card(
      "guestFlows",
      "settings.navigation.guestFlows",
      ClipboardDocumentCheckIcon,
      "/settings/guest-flows",
    ),
    card(
      "otaCommissions",
      "settings.navigation.otaCommissions",
      ReceiptPercentIcon,
      "/settings/ota-commissions",
    ),
    card("team", "settings.navigation.team", UserGroupIcon, "/settings/team"),
    // PMS has no account page yet, the same as Booking Admin.
    card("account", "settings.navigation.account", UserCircleIcon),
    card("billing", "settings.navigation.billing", CreditCardIcon, "/settings/billing"),
  ];
  const featured = {
    title: t("layout.sidebar.featureHub"),
    description: t("settings.cards.featureHub.description"),
    icon: BoltIcon,
    href: "/settings/feature-hub",
  };
  if (!access) return { featured, cards };
  const canReadSettings = access.permissions.some((permission) =>
    ["pms.settings.read", "pms.settings.manage"].includes(permission),
  );
  return {
    featured,
    cards: cards.filter((item) => {
      if (item.id === "team") return access.permissions.includes("identity.staff.manage");
      if (item.id === "billing") return access.roleKey === "hotel_owner";
      if (item.id === "account") return true;
      return canReadSettings;
    }),
  };
}

// Settings used to be one page with anchors; search results and bookmarks still link to them.
const LEGACY_ANCHORS: Record<string, string> = {
  "property-details": "/settings/property",
  currency: "/settings/property#currency",
  language: "/settings/property#language",
  localization: "/settings/property#localization",
  // Booking Engine left PMS Settings; its arrival times live on the Property page.
  "booking-engine": "/settings/property#arrival-times",
  calendar: "/settings/calendar",
  "ota-commissions": "/settings/ota-commissions",
  "checkin-checklist": "/settings/check-in#extra-checks",
  "checkout-inspection": "/settings/guest-flows#check-out",
};

/** Where an old `/settings#anchor` link now lives, or null to stay on the card grid. */
export function legacySettingsAnchorTarget(hash: string): string | null {
  return LEGACY_ANCHORS[hash.replace(/^#/, "")] ?? null;
}
