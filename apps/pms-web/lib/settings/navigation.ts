import {
  BoltIcon,
  CalendarDaysIcon,
  ClipboardDocumentCheckIcon,
  CreditCardIcon,
  GlobeAltIcon,
  ReceiptPercentIcon,
  UserGroupIcon,
} from "@heroicons/react/24/outline";
import { HotelIcon } from "@vayada/product-onboarding";
import type { SettingsNavSection } from "@vayada/settings-ui";
import type { PmsSelfAccess } from "@/services/api/pmsStaffClient";

export function getPmsSettingsSections(
  indexPage: boolean,
  t: (key: string) => string,
  access?: PmsSelfAccess,
): SettingsNavSection[] {
  const anchorHref = (id: string) => (indexPage ? undefined : `/settings#${id}`);

  const sections = [
    {
      id: "property-details",
      label: t("settings.navigation.property"),
      icon: HotelIcon,
      href: anchorHref("property-details"),
    },
    {
      id: "calendar",
      label: t("settings.navigation.calendar"),
      icon: CalendarDaysIcon,
      href: anchorHref("calendar"),
    },
    {
      id: "booking-engine",
      label: t("settings.navigation.bookingEngine"),
      icon: BoltIcon,
      href: anchorHref("booking-engine"),
    },
    {
      id: "ota-commissions",
      label: t("settings.navigation.otaCommissions"),
      icon: ReceiptPercentIcon,
      href: anchorHref("ota-commissions"),
    },
    {
      id: "checkin-checklist",
      label: t("settings.navigation.checkinChecklist"),
      icon: ClipboardDocumentCheckIcon,
      href: "/settings/checkin-checklist",
    },
    {
      id: "checkout-inspection",
      label: t("settings.navigation.checkoutInspection"),
      icon: ClipboardDocumentCheckIcon,
      href: "/settings/checkout-inspection",
    },
    {
      id: "team",
      label: t("settings.navigation.team"),
      icon: UserGroupIcon,
      href: "/settings/team",
    },
    {
      id: "billing",
      label: t("settings.navigation.billing"),
      icon: CreditCardIcon,
      href: "/settings/billing",
    },
    {
      id: "localization",
      label: t("settings.navigation.localization"),
      icon: GlobeAltIcon,
      href: anchorHref("localization"),
    },
  ];
  if (!access) return sections;
  const canReadSettings = access.permissions.some((permission) =>
    ["pms.settings.read", "pms.settings.manage"].includes(permission),
  );
  return sections.filter((section) => {
    if (section.id === "team") return access.permissions.includes("identity.staff.manage");
    if (section.id === "billing") return access.roleKey === "hotel_owner";
    return canReadSettings;
  });
}
