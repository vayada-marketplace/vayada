import { describe, expect, it, vi } from "vitest";
import { createHotelMediaResolutionPort } from "@vayada/domain-hotels";
import { readMarketplacePublicHotel } from "./marketplacePublicHotel.js";

const propertyId = "e1943000-0000-4000-8000-000000000003";
const organizationId = "e1943000-0000-4000-8000-000000000002";
const mediaObjectId = "e1943000-0000-4000-8000-000000000004";
function fixture() {
  const row = {
    revisionId: "e1943000-0000-4000-8000-000000000005",
    organizationId,
    snapshot: {
      contractVersion: "marketplace-submission-snapshot.v1",
      catalog: {
        contractVersion: "marketplace-catalog-submission.v1",
        propertyId,
        profile: {
          displayName: "Approved hotel",
          propertyType: "hotel",
          location: {
            localityPublic: false,
            city: "Private city",
            countryCode: "DE",
            streetAddress: "Private street",
          },
          contacts: [{ value: "private@example.test" }],
        },
        presentation: { shortDescription: "Approved description" },
        media: [
          {
            mediaObjectId,
            mediaType: "logo",
            url: "https://stale.example.test/logo",
            altText: null,
            sortOrder: 0,
          },
        ],
      },
      preferences: { privateNote: "Never public" },
    },
  };
  const query = vi.fn().mockResolvedValue({ rows: [row] });
  const loadPublicMedia = vi.fn().mockImplementation(async (input) => ({
    ok: true,
    resolvedTarget: input.target,
    media: [
      {
        mediaObjectId,
        ownerOrganizationId: organizationId,
        propertyId,
        purpose: "property.logo",
        publicVariants: [
          { variantName: "original_safe", publicUrl: "https://cdn.example.test/current.webp" },
        ],
      },
    ],
  }));
  return {
    row,
    query,
    loadPublicMedia,
    resolver: createHotelMediaResolutionPort({ loadPublicMedia }),
  };
}
describe("approved Marketplace public projection", () => {
  it("whitelists approved fields and honors private locality without serving snapshot URLs", async () => {
    const f = fixture();
    expect(await readMarketplacePublicHotel(f, f.resolver, propertyId)).toEqual({
      propertyId,
      revisionId: f.row.revisionId,
      displayName: "Approved hotel",
      propertyType: "hotel",
      shortDescription: "Approved description",
      locality: null,
      media: [{ mediaType: "logo", url: "https://cdn.example.test/current.webp", altText: null }],
    });
    expect(f.loadPublicMedia).toHaveBeenCalledWith({
      ownerOrganizationId: organizationId,
      target: { kind: "property", propertyId },
      mediaObjectIds: [mediaObjectId],
    });
  });
  it("does not return a revision withdrawn while resolving media", async () => {
    const f = fixture();
    f.query.mockResolvedValueOnce({ rows: [f.row] }).mockResolvedValueOnce({ rows: [] });
    expect(await readMarketplacePublicHotel(f, f.resolver, propertyId)).toBeNull();
  });
  it("rejects a cross-property snapshot before media access", async () => {
    const f = fixture();
    f.row.snapshot.catalog.propertyId = organizationId;
    await expect(readMarketplacePublicHotel(f, f.resolver, propertyId)).rejects.toThrow(
      "snapshot unavailable",
    );
    expect(f.loadPublicMedia).not.toHaveBeenCalled();
  });
  it("fails closed on a provider failure", async () => {
    const f = fixture();
    f.loadPublicMedia.mockRejectedValue(new Error("provider down"));
    await expect(readMarketplacePublicHotel(f, f.resolver, propertyId)).rejects.toThrow(
      "provider down",
    );
  });
  it("rejects malformed IDs without querying", async () => {
    const f = fixture();
    await expect(readMarketplacePublicHotel(f, f.resolver, "invalid")).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
});
