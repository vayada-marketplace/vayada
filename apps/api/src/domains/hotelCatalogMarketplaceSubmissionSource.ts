import { createHash } from "node:crypto";
import {
  normalizeHotelCatalogStep1Summary,
  parsePropertyProfileResponse,
  parsePublicPropertyProfileResponse,
  parseHotelCatalogStep1ReadModel,
  type PropertyProfileResponse,
  type PublicPropertyProfileResponse,
  type ReadinessGroupResult,
  type ReadinessBlocker,
  type SourceEntityRevision,
} from "@vayada/domain-hotels";
import type {
  HotelCatalogStep1Repository,
  HotelCatalogStep1Scope,
} from "./hotelCatalogStep1Repository.js";

type Scope = HotelCatalogStep1Scope;
type ProfileReader = {
  getPropertyProfile(scope: Scope): Promise<PropertyProfileResponse | null>;
  getPublicPropertyProfile(scope: Scope): Promise<PublicPropertyProfileResponse | null>;
};
export type MarketplaceCatalogSnapshot = {
  contractVersion: "marketplace-catalog-submission.v1";
  propertyId: string;
  profileRevision: number;
  profile: PropertyProfileResponse["profile"];
  presentation: NonNullable<ReturnType<typeof parseHotelCatalogStep1ReadModel>>["profile"];
  media: PublicPropertyProfileResponse["publicProfile"]["media"];
};
export type MarketplaceCatalogSubmissionEvidence = {
  source: SourceEntityRevision;
  group: ReadinessGroupResult;
  snapshot: MarketplaceCatalogSnapshot;
};
export type MarketplaceCatalogSubmissionSource = {
  getSubmissionEvidence(scope: Scope): Promise<MarketplaceCatalogSubmissionEvidence>;
};

/** Hotel Catalog owns these facts. Consumers receive one versioned snapshot. */
export function createHotelCatalogMarketplaceSubmissionSource(config: {
  step1: Pick<HotelCatalogStep1Repository, "getState">;
  profiles: ProfileReader;
}): MarketplaceCatalogSubmissionSource {
  async function read(scope: Scope): Promise<MarketplaceCatalogSnapshot> {
    const state = await config.step1.getState(scope);
    const rawProfile = await config.profiles.getPropertyProfile(scope);
    const rawPublic = await config.profiles.getPublicPropertyProfile(scope);
    const profile = parsePropertyProfileResponse(rawProfile);
    const publicProfile = parsePublicPropertyProfileResponse(rawPublic);
    const presentation = parseHotelCatalogStep1ReadModel(state?.readModel);
    if (
      !profile ||
      !publicProfile ||
      !presentation ||
      [profile, publicProfile, presentation].some(
        (value) =>
          value.propertyId !== scope.propertyId ||
          value.profileRevision !== profile.profileRevision,
      )
    )
      throw new Error("Hotel Catalog submission source is unavailable or changed while loading.");
    if (publicProfile.publicProfile.media.some((media) => !safeUrl(media.url)))
      throw new Error("Hotel Catalog public media is unavailable.");
    return {
      contractVersion: "marketplace-catalog-submission.v1",
      propertyId: scope.propertyId,
      profileRevision: profile.profileRevision,
      profile: profile.profile,
      presentation: presentation.profile,
      media: publicProfile.publicProfile.media,
    };
  }
  return {
    async getSubmissionEvidence(scope) {
      const snapshot = await read(scope);
      const hash = fingerprint(snapshot);
      // Media approval can change without the property profile revision changing.
      if (fingerprint(await read(scope)) !== hash)
        throw new Error("Hotel Catalog submission source changed while loading.");
      const source: SourceEntityRevision = {
        ownerDomain: "hotel_catalog",
        entityType: "marketplace_submission_profile",
        entityId: scope.propertyId,
        revision: `catalog:${snapshot.profileRevision}:${hash}`,
      };
      const blockers: ReadinessBlocker[] = [];
      const block = (code: string, message: string) =>
        blockers.push({
          kind: "user_fixable",
          code,
          message,
          product: "marketplace",
          groupId: "marketplace.hotel_profile",
          owningStepId: "present_hotel",
          source,
        });
      const profile = snapshot.profile;
      if (!profile.displayName.trim() || !profile.propertyType.trim())
        block("hotel_identity_incomplete", "Complete your hotel's name and property type.");
      const location = profile.location;
      if (
        ![
          location.streetAddress,
          location.postalCode,
          location.city,
          location.countryCode,
          location.timezone,
        ].every((value) => value.trim()) ||
        location.latitude === null ||
        location.longitude === null ||
        Math.abs(location.latitude) > 90 ||
        Math.abs(location.longitude) > 180
      )
        block("hotel_location_incomplete", "Complete your hotel's address and map location.");
      for (const channelType of ["email", "phone"] as const)
        if (
          !profile.contacts.some(
            (contact) => contact.channelType === channelType && contact.value.trim(),
          )
        )
          block(`hotel_${channelType}_missing`, `Add your hotel's contact ${channelType}.`);
      if (!normalizeHotelCatalogStep1Summary(snapshot.presentation.shortDescription))
        block("hotel_summary_incomplete", "Add a hotel summary between 50 and 500 characters.");
      if (!snapshot.presentation.publicSlug?.trim())
        block(
          "hotel_public_slug_missing",
          "Save your hotel presentation to prepare its public address.",
        );
      if (!snapshot.media.some((media) => media.mediaType === "logo" && safeUrl(media.url)))
        block("hotel_logo_missing", "Add your hotel's logo in the property details.");
      // Cover/gallery and amenities are recommendations, not Marketplace launch requirements.
      const status = blockers.length ? "blocked" : "ready";
      return structuredClone({
        source,
        snapshot,
        group: {
          groupId: "marketplace.hotel_profile",
          status,
          steps: [
            { owningStepId: "present_hotel", status, entities: [{ source, status, blockers }] },
          ],
        },
      });
    },
  };
}
function fingerprint(value: MarketplaceCatalogSnapshot): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function safeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
