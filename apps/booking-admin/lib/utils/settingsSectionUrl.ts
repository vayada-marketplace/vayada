// VAY-2072: Settings is a card grid and every card opens its own /settings/<page>.
export const SETTINGS_PAGES = [
  "general",
  "booking-rules",
  "policies",
  "payments",
  "billing",
] as const;

export type SettingsPageId = (typeof SETTINGS_PAGES)[number];

export function isSettingsPage(value: string): value is SettingsPageId {
  return (SETTINGS_PAGES as readonly string[]).includes(value);
}

// Sections of the former single Settings page. Stripe Connect onboarding (?section=payments&stripe=),
// Stripe plan checkout (?billing=) and other apps still link to these URLs.
const LEGACY_SECTION_PAGES = new Map<string, SettingsPageId>([
  ["property", "general"],
  ["localization", "general"],
  ["booking", "booking-rules"],
  ["billing", "billing"],
  ["payments", "payments"],
]);

/** The sub-page for a legacy /settings query, keeping every other parameter and the hash. */
export function legacySettingsPageUrl(search: string, hash = ""): string | null {
  const params = new URLSearchParams(search);
  const section = params.get("section");
  const page =
    (section !== null && LEGACY_SECTION_PAGES.get(section)) ||
    (params.has("billing") ? "billing" : params.has("stripe") ? "payments" : null);
  if (!page) return null;
  params.delete("section");
  const query = params.toString();
  return `/settings/${page}${query ? `?${query}` : ""}${hash}`;
}
