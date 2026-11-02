import { isValidSharedAccountPhone } from "@vayada/product-onboarding";

import { quickHotelErrors, type QuickHotelDraft } from "../quick/quickHotelDraft";

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
