import type {
  PropertyProfile,
  PropertyProfileContact,
  PropertyProfilePatch,
} from "@vayada/domain-hotels";

import { quickHotelCurrency, type QuickHotelCurrency } from "./quickHotelCurrency";
import { EMPTY_QUICK_HOTEL_DRAFT, type QuickHotelDraft } from "./quickHotelDraft";

/**
 * VAY-2247 "Your hotel" for a hotel that exists (Back from step 3): the form filled in from its profile,
 * with the currency only when it differs from its country's.
 */
export function quickHotelDraftFromProfile(
  profile: PropertyProfile,
  savedCurrency: string | null,
): QuickHotelDraft {
  const { location } = profile;
  const contact = (type: "email" | "phone") =>
    profile.contacts.find((item) => item.channelType === type)?.value ?? "";
  const fromCountry = quickHotelCurrency(location.countryCode, "")?.code ?? null;
  return {
    ...EMPTY_QUICK_HOTEL_DRAFT,
    displayName: profile.displayName,
    propertyType: profile.propertyType,
    streetAddress: location.streetAddress,
    postalCode: location.postalCode,
    city: location.city,
    countryCode: location.countryCode,
    latitude: location.latitude,
    longitude: location.longitude,
    timezone: location.timezone,
    contactEmail: contact("email"),
    phone: contact("phone"),
    currency: savedCurrency && savedCurrency !== fromCountry ? savedCurrency : "",
  };
}

/**
 * Only what "Your hotel" shows changes: the name, the type, the address and the first email and phone.
 * Everything else on the profile (other contacts, what the map shows, the city being public) stays.
 */
export function quickHotelProfilePatch(
  draft: QuickHotelDraft,
  profile: PropertyProfile,
): PropertyProfilePatch {
  const contacts: PropertyProfileContact[] = [...profile.contacts];
  for (const [type, value] of [
    ["phone", draft.phone.trim()],
    ["email", draft.contactEmail.trim()],
  ] as const) {
    const at = contacts.findIndex((item) => item.channelType === type);
    if (at >= 0) contacts[at] = { ...contacts[at]!, value };
    else contacts.push({ channelType: type, value, purpose: "general", isPublic: true });
  }
  return {
    displayName: draft.displayName.trim(),
    propertyType: draft.propertyType,
    location: {
      streetAddress: draft.streetAddress.trim(),
      postalCode: draft.postalCode.trim(),
      city: draft.city.trim(),
      countryCode: draft.countryCode.trim().toUpperCase(),
      timezone: draft.timezone.trim(),
      latitude: draft.latitude,
      longitude: draft.longitude,
    },
    contacts,
  };
}

/**
 * Whether the edit changes the hotel's pricing currency: before the first run saved one, only an own
 * choice is saved (as at creation; the first run takes the country's); after, any difference is.
 */
export function quickHotelCurrencyToSave(
  currency: QuickHotelCurrency,
  savedCurrency: string | null,
): string | null {
  if (savedCurrency === null) return currency.fromCountry ? null : currency.code;
  return savedCurrency === currency.code ? null : currency.code;
}
