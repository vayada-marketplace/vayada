import type { SearchResultKind } from "@vayada/settings-ui";
import { settingsService } from "@/services/settings";
import { dashboardService } from "@/services/dashboard";
import { moduleActivationClient } from "@/services/api/moduleActivationClient";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import { getFinancePaymentSettings } from "@/services/api/financePaymentSettingsClient";
import { getFinancePlanStatus } from "@/services/api/financeSubscriptionsClient";

// [label, href, category, access read, label key, description key, icon kind]. Keep each
// category's entries together: the result list starts a header at every category change.
export const SEARCH_ENTRIES = [
  [
    "Dashboard",
    "/",
    "Pages",
    "dashboard",
    "layout.sidebar.dashboard",
    "navigation.searchHint.dashboard",
    "dashboard",
  ],
  [
    "Design Studio",
    "/design-studio",
    "Pages",
    "design",
    "layout.sidebar.designStudio",
    "navigation.searchHint.designStudio",
    "design",
  ],
  [
    "Add-ons",
    "/add-ons",
    "Pages",
    "add-ons",
    "bookingFlow.tabs.addons",
    "navigation.searchHint.addons",
    "addon",
  ],
  [
    "Promo Codes",
    "/promo-codes",
    "Pages",
    "promos",
    "bookingFlow.promoCodes.title",
    "navigation.searchHint.promoCodes",
    "promo",
  ],
  [
    "Settings",
    "/settings",
    "Pages",
    "settings",
    "layout.sidebar.settings",
    "navigation.searchHint.settings",
    "setting",
  ],
  [
    "Feature Hub",
    "/settings/feature-hub",
    "Pages",
    "modules",
    "layout.sidebar.featureHub",
    "navigation.searchHint.featureHub",
    "module",
  ],
  [
    "General",
    "/settings/general",
    "Settings",
    "settings",
    "settings.cards.general.title",
    "navigation.searchHint.general",
    "setting",
  ],
  [
    "Languages and currencies",
    "/settings/general#localization",
    "Settings",
    "settings",
    "bookingFlow.tabs.localization",
    "navigation.searchHint.localization",
    "setting",
  ],
  [
    "Location & surroundings",
    "/settings/location",
    "Settings",
    "location",
    "admin.locationAndSurroundings",
    "navigation.searchHint.location",
    "location",
  ],
  [
    "Booking rules",
    "/settings/booking-rules",
    "Settings",
    "settings",
    "settings.cards.bookingRules.title",
    "navigation.searchHint.bookingRules",
    "setting",
  ],
  [
    "Policies",
    "/settings/policies",
    "Settings",
    "settings",
    "settings.cards.policies.title",
    "navigation.searchHint.policies",
    "setting",
  ],
  [
    "Billing",
    "/settings/billing",
    "Settings",
    "billing",
    "settings.tabs.billing",
    "navigation.searchHint.billing",
    "setting",
  ],
  [
    "Payment Settings",
    "/settings/payments",
    "Settings",
    "payments",
    "admin.paymentSettings",
    "navigation.searchHint.payments",
    "setting",
  ],
  [
    "Privacy & data",
    "/settings/privacy",
    "Settings",
    "settings",
    "settings.cards.privacy.title",
    "navigation.searchHint.privacy",
    "setting",
  ],
  [
    "Room Filters",
    "/settings/room-filters",
    "Settings",
    "settings",
    "settings.cards.roomFilters.title",
    "navigation.searchHint.roomFilters",
    "setting",
  ],
  [
    "Room Sorting",
    "/settings/room-sorting",
    "Settings",
    "settings",
    "settings.cards.roomSorting.title",
    "navigation.searchHint.roomSorting",
    "setting",
  ],
  [
    "Book Direct Benefits",
    "/settings/book-direct-benefits",
    "Settings",
    "settings",
    "settings.cards.benefits.title",
    "navigation.searchHint.benefits",
    "setting",
  ],
  [
    "Guest Form",
    "/settings/guest-form",
    "Settings",
    "settings",
    "settings.cards.guestForm.title",
    "navigation.searchHint.guestForm",
    "setting",
  ],
  [
    "Domain Settings",
    "/design-studio?tab=domain",
    "Design Studio",
    "design",
    "admin.domainSettings",
    "navigation.searchHint.domain",
    "design",
  ],
  [
    "Media and images",
    "/design-studio?tab=media",
    "Design Studio",
    "design",
    "admin.mediaAndImages",
    "navigation.searchHint.media",
    "design",
  ],
  [
    "Themes and colors",
    "/design-studio?tab=colors",
    "Design Studio",
    "design",
    "admin.themesAndColors",
    "navigation.searchHint.colors",
    "design",
  ],
  [
    "Fonts",
    "/design-studio?tab=fonts",
    "Design Studio",
    "design",
    "designStudio.tabs.fonts",
    "navigation.searchHint.fonts",
    "design",
  ],
  [
    "Layout",
    "/design-studio?tab=layout",
    "Design Studio",
    "design",
    "admin.layout",
    "navigation.searchHint.layout",
    "design",
  ],
] as const satisfies readonly (readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  SearchResultKind,
])[];

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
    // The Location page starts from the property link; it is a settings page too.
    location: property,
  };
  const results = await Promise.allSettled(Object.values(checks));
  const access = new Set(
    Object.keys(checks).filter((_, index) => results[index].status === "fulfilled"),
  );
  if (!access.has("settings")) access.delete("location");
  // Add-ons and Promos follow the settings read, unless Feature Hub says they are off (VAY-2200).
  const listed = await modules.catch(() => null);
  for (const moduleId of ["add-ons", "promos"]) {
    const off =
      listed?.supportedModules?.includes(moduleId) && !listed.activeModules?.includes(moduleId);
    if (access.has("settings") && !off) access.add(moduleId);
  }
  return access;
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
