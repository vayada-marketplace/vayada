import {
  HOTEL_CATALOG_STEP1_SUMMARY_MAX_LENGTH,
  HOTEL_CATALOG_STEP1_SUMMARY_MIN_LENGTH,
  normalizeHotelCatalogStep1Summary,
} from "@vayada/domain-hotels";
import type { SharedHotelSetupApi } from "@vayada/product-onboarding";

// The booking site footer shows the hotel's short description: the same text as setup's
// "Short hotel summary", so it follows the same 50–500 character rule (VAY-2142).
export const PROPERTY_DESCRIPTION_MIN_LENGTH = HOTEL_CATALOG_STEP1_SUMMARY_MIN_LENGTH;
export const PROPERTY_DESCRIPTION_MAX_LENGTH = HOTEL_CATALOG_STEP1_SUMMARY_MAX_LENGTH;

export function propertyDescriptionLength(value: string): number {
  return Array.from(value.trim()).length;
}

/** The trimmed description, or null when setup or the profile API would reject it. */
export function normalizePropertyDescription(value: string): string | null {
  const normalized = normalizeHotelCatalogStep1Summary(value);
  // The API counts UTF-16 units, so emoji count twice there.
  return normalized && normalized.length <= PROPERTY_DESCRIPTION_MAX_LENGTH ? normalized : null;
}

/** Saves against the current profile revision; an unchanged text writes nothing. */
export async function savePropertyDescription(
  api: Pick<SharedHotelSetupApi, "getPublicPropertyProfile" | "updatePublicPropertyProfile">,
  propertyId: string,
  description: string,
): Promise<string> {
  const current = await api.getPublicPropertyProfile(propertyId);
  if (current.publicProfile.shortDescription === description) return description;
  const saved = await api.updatePublicPropertyProfile(propertyId, {
    expectedProfileRevision: current.profileRevision,
    patch: { shortDescription: description },
  });
  return saved.publicProfile.shortDescription ?? "";
}
