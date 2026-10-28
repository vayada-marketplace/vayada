import { resolveLocale } from "@/lib/utils";

/** The hotel's country for the times line: an ISO code by its name in the page's language, a
 * name as it came, null without one (a hotel that hides its address sends none). */
export function hotelCountryName(country: string | null | undefined, locale?: string) {
  const value = country?.trim();
  if (!value) return null;
  if (!/^[A-Za-z]{2}$/.test(value)) return value;
  try {
    return (
      new Intl.DisplayNames([resolveLocale(locale)], { type: "region" }).of(value.toUpperCase()) ??
      value
    );
  } catch {
    return value;
  }
}
