import { COUNTRY_OPTIONS } from "@vayada/locale-constants";
import { isValidSharedAccountPhone } from "@vayada/product-onboarding";

/** VAY-2247 "Your hotel": what the owner types before the hotel exists (kept by the host as they type). */
export type QuickHotelDraft = {
  displayName: string;
  propertyType: string;
  streetAddress: string;
  postalCode: string;
  city: string;
  countryCode: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  contactEmail: string;
  phone: string;
  /** Another currency than the country's; "" follows the country. */
  currency: string;
  /** The pin came from a pasted Google Maps link (VAY-2444): typing the address keeps it. */
  pinFromLink?: boolean;
};

export type QuickHotelField = "displayName" | "propertyType" | "address" | "contactEmail" | "phone";
export type QuickHotelErrors = Partial<Record<QuickHotelField, string>>;

export const EMPTY_QUICK_HOTEL_DRAFT: QuickHotelDraft = Object.freeze({
  displayName: "",
  propertyType: "",
  streetAddress: "",
  postalCode: "",
  city: "",
  countryCode: "",
  latitude: null,
  longitude: null,
  timezone: "",
  contactEmail: "",
  phone: "",
  currency: "",
});

/** The pills shown first, in this order; every other type sits behind "More…". */
export const QUICK_PROPERTY_TYPE_ORDER = [
  "hotel",
  "guesthouse",
  "bed_and_breakfast",
  "apartment",
  "resort",
  "hostel",
  "villa",
] as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What blocks Continue on "Your hotel" (the logo is optional). */
export function quickHotelErrors(draft: QuickHotelDraft): QuickHotelErrors {
  const errors: QuickHotelErrors = {};
  if (!draft.displayName.trim()) errors.displayName = "Enter your hotel's name.";
  if (!draft.propertyType) errors.propertyType = "Choose a property type.";
  if (
    !draft.streetAddress.trim() ||
    !draft.city.trim() ||
    !COUNTRY_OPTIONS.some((country) => country.code === draft.countryCode) ||
    !draft.timezone.trim()
  ) {
    errors.address =
      "Choose your address from the list, paste a Google Maps link, or enter it manually.";
  }
  if (!draft.contactEmail.trim()) errors.contactEmail = "Enter an email guests can write to.";
  else if (!EMAIL.test(draft.contactEmail.trim()))
    errors.contactEmail = "Enter a valid email address.";
  if (!draft.phone.trim()) errors.phone = "Enter a phone number guests can call.";
  else if (!isValidSharedAccountPhone(draft.phone)) errors.phone = "Enter a valid phone number.";
  return errors;
}

/** The server's rule for the address (ensureCanonicalPropertySlug's slugify): the name, URL-safe. */
function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

/**
 * The booking-page address shown in the preview: what the server reserves when the hotel is created
 * ("Hotel Alpenrose" → "hotel-alpenrose.booking.vayada.com"). If another hotel has that name, the
 * server adds the hotel's id, which the preview can't know yet.
 */
export function previewBookingHost(displayName: string): string {
  return `${slug(displayName) || "yourhotel"}.booking.vayada.com`;
}
