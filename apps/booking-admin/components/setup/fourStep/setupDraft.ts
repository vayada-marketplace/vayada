import type {
  PropertyProfile,
  PropertyProfileContact,
  PropertyProfilePatch,
} from "@vayada/domain-hotels";
import { LANGUAGE_OPTIONS } from "@vayada/locale-constants";
import { isValidSharedAccountPhone } from "@vayada/product-onboarding";

import { quickHotelCurrency } from "../quick/quickHotelCurrency";
import { quickHotelErrors, type QuickHotelDraft } from "../quick/quickHotelDraft";
import { quickHotelDraftFromProfile, quickHotelProfilePatch } from "../quick/quickHotelEdit";

/** The new hotel's language: the browser's first one the booking page offers, else English. */
export function setupLanguage(browser: readonly string[] | undefined): string {
  for (const tag of browser ?? []) {
    const code = tag.toLowerCase().split("-")[0];
    if (code && LANGUAGE_OPTIONS.some((option) => option.code === code)) return code;
  }
  return "en";
}

/** VAY-2451 step 2's four social links, in the mockup's order. */
export const SETUP_SOCIALS = [
  { key: "instagram", label: "Instagram", placeholder: "https://instagram.com/yourproperty" },
  { key: "facebook", label: "Facebook", placeholder: "https://facebook.com/yourproperty" },
  { key: "youtube", label: "YouTube", placeholder: "https://youtube.com/@yourproperty" },
  { key: "tiktok", label: "TikTok", placeholder: "https://tiktok.com/@yourproperty" },
] as const;
export type SetupSocialKey = (typeof SETUP_SOCIALS)[number]["key"];

/** A social link is the full https link (the booking page shows only those); empty is fine. */
export function socialLinkValid(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return true;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Why step 1 can't continue yet, or null. */
export function propertyStepHint(draft: QuickHotelDraft): string | null {
  const errors = quickHotelErrors(draft);
  if (errors.displayName) return "Add your property's name to continue";
  if (errors.propertyType) return "Choose a property type to continue";
  return null;
}

/**
 * Why step 2 can't continue yet, or null: the server needs the full address with its time zone, the
 * reception email and phone to create the property.
 */
export function locationStepHint(draft: QuickHotelDraft, currencyKnown: boolean): string | null {
  const errors = quickHotelErrors(draft);
  if (errors.address || !currencyKnown) return "Add your address to continue";
  if (errors.contactEmail) return "Add a valid reception email to continue";
  if (errors.phone) return "Add a valid reception phone to continue";
  if (
    draft.whatsappSameAsPhone === false &&
    draft.whatsapp?.trim() &&
    !isValidSharedAccountPhone(draft.whatsapp)
  )
    return "Check the WhatsApp number, or tick Same as phone";
  if (SETUP_SOCIALS.some(({ key }) => !socialLinkValid(draft[key])))
    return "Use the full social links, starting with https://";
  return null;
}

/**
 * Steps 1 and 2 of a hotel that exists (VAY-2451): the form filled in from its profile, as the 7-step
 * setup's edit does, with WhatsApp: the phone unless the hotel has another WhatsApp number.
 */
export function setupDraftFromProfile(
  profile: PropertyProfile,
  savedCurrency: string | null,
): QuickHotelDraft {
  const draft = quickHotelDraftFromProfile(profile, savedCurrency);
  const whatsapp =
    profile.contacts.find((contact) => contact.channelType === "whatsapp")?.value.trim() ?? "";
  const same = !whatsapp || whatsapp === draft.phone.trim();
  return { ...draft, whatsappSameAsPhone: same, whatsapp: same ? "" : whatsapp };
}

/**
 * What steps 1 and 2 change on the profile: the 7-step edit's patch (name, type, address, the first email and
 * phone) and the first WhatsApp contact, which goes when the owner leaves it empty. Other contacts stay.
 */
export function setupProfilePatch(
  draft: QuickHotelDraft,
  profile: PropertyProfile,
): PropertyProfilePatch {
  const patch = quickHotelProfilePatch(draft, profile);
  const contacts: PropertyProfileContact[] = [...(patch.contacts ?? profile.contacts)];
  const whatsapp = (
    draft.whatsappSameAsPhone !== false ? draft.phone : (draft.whatsapp ?? "")
  ).trim();
  const at = contacts.findIndex((contact) => contact.channelType === "whatsapp");
  if (whatsapp && at >= 0) contacts[at] = { ...contacts[at]!, value: whatsapp };
  else if (whatsapp)
    contacts.push({ channelType: "whatsapp", value: whatsapp, purpose: "general", isPublic: true });
  else if (at >= 0) contacts.splice(at, 1);
  return { ...patch, contacts };
}

/**
 * Which of steps 1 and 2 a hotel that exists still lacks (one an older setup made without its address or
 * contacts), or null: setup opens there before the room.
 */
export function hotelDetailsStepToFinish(draft: QuickHotelDraft): "property" | "location" | null {
  if (propertyStepHint(draft)) return "property";
  const currencyKnown = Boolean(quickHotelCurrency(draft.countryCode, draft.currency));
  return locationStepHint(draft, currencyKnown) ? "location" : null;
}
