import { settingsService } from "@/services/settings";
import { dashboardService } from "@/services/dashboard";
import { moduleActivationClient } from "@/services/api/moduleActivationClient";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import { getFinancePaymentSettings } from "@/services/api/financePaymentSettingsClient";
import { getFinancePlanStatus } from "@/services/api/financeSubscriptionsClient";

export const SEARCH_ENTRIES = [
  ["Dashboard", "/", "Pages", "dashboard", "layout.sidebar.dashboard"],
  ["Design Studio", "/design-studio", "Pages", "design", "layout.sidebar.designStudio"],
  ["Booking Flow", "/booking-flow", "Pages", "settings", "layout.sidebar.bookingFlow"],
  ["Promo Codes", "/promo-codes", "Pages", "settings", "bookingFlow.promoCodes.title"],
  ["Settings", "/settings", "Pages", "settings", "layout.sidebar.settings"],
  ["Feature Hub", "/settings/feature-hub", "Pages", "modules", "layout.sidebar.featureHub"],
  ["General", "/settings/general", "Settings", "settings", "settings.cards.general.title"],
  [
    "Languages and currencies",
    "/settings/general#localization",
    "Settings",
    "settings",
    "bookingFlow.tabs.localization",
  ],
  [
    "Booking rules",
    "/settings/booking-rules",
    "Settings",
    "settings",
    "settings.cards.bookingRules.title",
  ],
  ["Policies", "/settings/policies", "Settings", "settings", "settings.cards.policies.title"],
  ["Billing", "/settings/billing", "Settings", "billing", "settings.tabs.billing"],
  ["Payment Settings", "/settings/payments", "Settings", "payments", "admin.paymentSettings"],
  [
    "Domain Settings",
    "/design-studio?tab=domain",
    "Design Studio",
    "design",
    "admin.domainSettings",
  ],
  [
    "Media and images",
    "/design-studio?tab=media",
    "Design Studio",
    "design",
    "admin.mediaAndImages",
  ],
  [
    "Themes and colors",
    "/design-studio?tab=colors",
    "Design Studio",
    "design",
    "admin.themesAndColors",
  ],
  ["Fonts", "/design-studio?tab=fonts", "Design Studio", "design", "designStudio.tabs.fonts"],
  ["Layout", "/design-studio?tab=layout", "Design Studio", "design", "admin.layout"],
  [
    "Room filters",
    "/booking-flow?tab=rooms",
    "Booking Flow",
    "settings",
    "bookingFlow.tabs.filters",
  ],
  ["Add-ons", "/add-ons", "Pages", "settings", "bookingFlow.tabs.addons"],
  [
    "Book Direct Benefits",
    "/settings/book-direct-benefits",
    "Settings",
    "settings",
    "settings.cards.benefits.title",
  ],
  [
    "Guest form",
    "/booking-flow?tab=guest-form",
    "Booking Flow",
    "settings",
    "bookingFlow.tabs.guestForm",
  ],
] as const;

export type SearchAccess = Set<string>;

// Read through the same protected APIs as the destination; never infer access from a role name.
export async function loadSearchAccess(hotelId: string): Promise<SearchAccess> {
  const property = getBookingHotelPropertyLink({ hotelId });
  const modules = moduleActivationClient.list();
  const checks: Record<string, Promise<unknown>> = {
    dashboard: dashboardService.getStats("today", "UTC"),
    settings: settingsService.getPropertySettings(hotelId),
    design: settingsService.getDesignSettings(hotelId),
    modules,
    payments: property.then(({ propertyId }) => getFinancePaymentSettings({ propertyId })),
    billing: property.then(({ propertyId }) => getFinancePlanStatus(propertyId)),
  };
  const results = await Promise.allSettled(Object.values(checks));
  return new Set(Object.keys(checks).filter((_, index) => results[index].status === "fulfilled"));
}

export function matchesSearch(query: string, text: string): boolean {
  const normalize = (value: string) =>
    value
      .toLocaleLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  const needle = normalize(query).trim();
  const haystack = normalize(text);
  if (haystack.includes(needle)) return true;
  // ponytail: tolerate one mistyped character in words of 4+ letters; no fuzzy-search dependency.
  return (
    needle.length >= 4 &&
    haystack.split(/\s+/).some((word) => {
      if (Math.abs(word.length - needle.length) > 1) return false;
      let i = 0,
        j = 0,
        edits = 0;
      while (i < needle.length && j < word.length) {
        if (needle[i] === word[j]) {
          i++;
          j++;
          continue;
        }
        if (++edits > 1) return false;
        if (needle.length >= word.length) i++;
        if (word.length >= needle.length) j++;
      }
      return edits + needle.length - i + word.length - j <= 1;
    })
  );
}
