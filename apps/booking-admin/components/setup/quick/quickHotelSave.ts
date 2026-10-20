import type { CreatePropertyProfileRequest, SetupTrack } from "@vayada/domain-hotels";
import type { SharedHotelSetupApi } from "@vayada/product-onboarding";

import type { QuickHotelCurrency } from "./quickHotelCurrency";
import type { QuickHotelDraft } from "./quickHotelDraft";

/** VAY-2247 "Your hotel" → the hotel profile the setup API creates (city and country public, VAY-2288). */
export function quickHotelProfileRequest(
  draft: QuickHotelDraft,
  currency: QuickHotelCurrency,
  language: string,
): CreatePropertyProfileRequest {
  return {
    displayName: draft.displayName.trim(),
    propertyType: draft.propertyType,
    location: {
      countryCode: draft.countryCode.trim().toUpperCase(),
      city: draft.city.trim(),
      streetAddress: draft.streetAddress.trim(),
      postalCode: draft.postalCode.trim(),
      timezone: draft.timezone.trim(),
      latitude: draft.latitude,
      longitude: draft.longitude,
      localityPublic: true,
      geoPublic: false,
      mapDisplayMode: "hidden",
    },
    contacts: [
      { channelType: "phone", value: draft.phone.trim(), purpose: "general", isPublic: true },
      {
        channelType: "email",
        value: draft.contactEmail.trim(),
        purpose: "general",
        isPublic: true,
      },
    ],
    initialLaunchSettings: {
      defaultCurrency: currency.code,
      supportedCurrencies: [currency.code],
      defaultLanguage: language,
      supportedLanguages: [language],
      instagram: "",
      facebook: "",
      tiktok: "",
      youtube: "",
    },
  };
}

export type QuickHotelSaveDeps = {
  setup: Pick<
    SharedHotelSetupApi,
    "createPropertyProfile" | "uploadPropertyLogo" | "assignPropertyLogo" | "updateTracks"
  >;
  /** Saves the pricing currency (only called when the owner chose another than the country's). */
  saveCurrency: (propertyId: string, currency: string) => Promise<void>;
};

export type QuickHotelSaveInput = {
  draft: QuickHotelDraft;
  currency: QuickHotelCurrency;
  language: string;
  logo: File | null;
  organization: { selectedTracks: readonly SetupTrack[]; trackRevision: number };
  /** One key per draft, kept with it, so a retry of the same Continue never creates a second hotel. */
  draftKey: string;
};

/**
 * Creates the hotel: the hotel-operations track first if the group has not chosen it, then the profile,
 * then the logo (optional) and the currency when the owner changed it. The server's first run reads
 * what is saved here and fills in everything else later.
 */
export async function saveQuickHotel(
  input: QuickHotelSaveInput,
  deps: QuickHotelSaveDeps,
): Promise<{ propertyId: string; logoSaved: boolean }> {
  const { organization, draftKey } = input;
  if (!organization.selectedTracks.includes("hotel_operations")) {
    await deps.setup.updateTracks(
      {
        selectedTracks: [...organization.selectedTracks, "hotel_operations"],
        expectedRevision: organization.trackRevision,
      },
      `quick-setup:tracks:${draftKey}`,
    );
  }
  const profile = await deps.setup.createPropertyProfile(
    quickHotelProfileRequest(input.draft, input.currency, input.language),
    `quick-setup:create:${draftKey}`,
  );
  let logoSaved = false;
  if (input.logo) {
    try {
      const mediaObjectId = await deps.setup.uploadPropertyLogo(
        profile.propertyId,
        input.logo,
        `quick-setup:logo:${draftKey}`,
      );
      await deps.setup.assignPropertyLogo(
        profile.propertyId,
        { expectedProfileRevision: profile.profileRevision, mediaObjectId, altText: null },
        `quick-setup:logo-assign:${draftKey}`,
      );
      logoSaved = true;
    } catch {
      // The logo is optional: the hotel is saved, and the logo can be added in Design Studio.
    }
  }
  if (!input.currency.fromCountry) {
    await deps.saveCurrency(profile.propertyId, input.currency.code);
  }
  return { propertyId: profile.propertyId, logoSaved };
}
