import type { HotelMediaResolutionPort } from "@vayada/domain-hotels";
import type { MarketplaceHotelCollaborationPreferencesClient } from "./marketplaceHotelCollaborationPreferencesRepository.js";
import { z } from "zod";

const snapshotSchema = z.object({
  contractVersion: z.literal("marketplace-submission-snapshot.v1"),
  catalog: z.object({
    contractVersion: z.literal("marketplace-catalog-submission.v1"),
    propertyId: z.string().uuid(),
    profile: z.object({
      displayName: z.string().trim().min(1),
      propertyType: z.string().trim().min(1),
      location: z.object({
        localityPublic: z.boolean(),
        city: z.string(),
        countryCode: z.string(),
      }),
    }),
    presentation: z.object({ shortDescription: z.string().min(1) }),
    media: z
      .array(
        z.object({
          mediaObjectId: z.string().uuid(),
          mediaType: z.enum(["logo", "hero_image", "gallery_image"]),
          altText: z.string().nullable(),
          sortOrder: z.number().int().nonnegative(),
        }),
      )
      .min(1)
      .max(100),
  }),
});

export type MarketplacePublicHotel = {
  propertyId: string;
  revisionId: string;
  displayName: string;
  propertyType: string;
  shortDescription: string;
  locality: { city: string; countryCode: string } | null;
  media: {
    mediaType: "logo" | "hero_image" | "gallery_image";
    url: string;
    altText: string | null;
  }[];
};

type ActiveSubmission = { revisionId: string; organizationId: string; snapshot: unknown };
const activeSubmissionSql = `
  SELECT revision.id AS "revisionId", revision.organization_id AS "organizationId",
         revision.submission_snapshot AS snapshot
  FROM marketplace.active_hotel_submission_revisions active
  JOIN marketplace.hotel_submission_revisions revision
    ON revision.id = active.submission_revision_id AND revision.property_id = active.property_id
  JOIN marketplace.hotel_submission_moderation moderation
    ON moderation.submission_revision_id = revision.id AND moderation.property_id = active.property_id
  WHERE active.property_id = $1::uuid AND active.activation_status = 'active'
    AND active.moderation_status = 'approved' AND moderation.status = 'approved'
`;

/** Private snapshot stays inside this adapter; only the explicit public projection leaves. */
export async function readMarketplacePublicHotel(
  client: Pick<MarketplaceHotelCollaborationPreferencesClient, "query">,
  mediaResolver: HotelMediaResolutionPort,
  propertyId: string,
): Promise<MarketplacePublicHotel | null> {
  const id = z.string().uuid().parse(propertyId).toLowerCase();
  const row = (await client.query<ActiveSubmission>(activeSubmissionSql, [id])).rows[0];
  if (!row) return null;
  const parsed = snapshotSchema.safeParse(row.snapshot);
  if (!parsed.success || parsed.data.catalog.propertyId.toLowerCase() !== id)
    throw new Error("Marketplace public snapshot unavailable");
  const catalog = parsed.data.catalog;
  const resolved = await mediaResolver.resolvePublicMedia({
    ownerOrganizationId: row.organizationId,
    target: { kind: "property", propertyId: id },
    mediaObjectIds: catalog.media.map((media) => media.mediaObjectId.toLowerCase()),
  });
  if (!resolved.ok) return null;
  const media: MarketplacePublicHotel["media"] = [];
  for (const item of [...catalog.media].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const current = resolved.batch.media.find(
      (value) => value.mediaObjectId === item.mediaObjectId.toLowerCase(),
    );
    const expectedPurpose =
      item.mediaType === "logo"
        ? "property.logo"
        : item.mediaType === "hero_image"
          ? "property.hero_image"
          : "property.gallery_image";
    if (!current || current.purpose !== expectedPurpose) return null;
    media.push({
      mediaType: item.mediaType,
      url: current.publicVariants.find((variant) => variant.variantName === "original_safe")!
        .publicUrl,
      altText: item.altText,
    });
  }
  const current = (await client.query<ActiveSubmission>(activeSubmissionSql, [id])).rows[0];
  if (current?.revisionId !== row.revisionId) return null;
  return {
    propertyId: id,
    revisionId: row.revisionId,
    displayName: catalog.profile.displayName,
    propertyType: catalog.profile.propertyType,
    shortDescription: catalog.presentation.shortDescription,
    locality: catalog.profile.location.localityPublic
      ? { city: catalog.profile.location.city, countryCode: catalog.profile.location.countryCode }
      : null,
    media,
  };
}
