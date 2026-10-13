import { describe, expect, it } from "vitest";

import type { ListingFormData } from "@/lib/types";

import { removeListingImageAt } from "./listingImageState";

describe("removeListingImageAt", () => {
  it("removes a persisted media image without removing a local upload", () => {
    const listing = listingWithMixedImages();

    const result = removeListingImageAt(listing, 0);

    expect(result.images).toEqual([
      "https://source.example/copy.jpg",
      "data:local-a",
      "data:local-b",
    ]);
    expect(result.imageMediaObjectIds).toEqual([]);
    expect(result.imageFiles).toEqual(listing.imageFiles);
  });

  it("removes a copied source image without shifting media ids or local uploads", () => {
    const listing = listingWithMixedImages();

    const result = removeListingImageAt(listing, 1);

    expect(result.images).toEqual([
      "https://media.example/one.jpg",
      "data:local-a",
      "data:local-b",
    ]);
    expect(result.imageMediaObjectIds).toEqual(["media-1"]);
    expect(result.imageFiles).toEqual(listing.imageFiles);
  });

  it("removes only the local file paired with the selected local preview", () => {
    const listing = listingWithMixedImages();

    const result = removeListingImageAt(listing, 3);

    expect(result.images).toEqual([
      "https://media.example/one.jpg",
      "https://source.example/copy.jpg",
      "data:local-a",
    ]);
    expect(result.imageMediaObjectIds).toEqual(["media-1"]);
    expect(result.imageFiles).toEqual([listing.imageFiles[0]]);
  });
});

function listingWithMixedImages(): ListingFormData {
  return {
    name: "Creator stay",
    location: "Berlin",
    description: "A creator collaboration offer.",
    accommodation_type: "hotel",
    images: [
      "https://media.example/one.jpg",
      "https://source.example/copy.jpg",
      "data:local-a",
      "data:local-b",
    ],
    imageMediaObjectIds: ["media-1"],
    imageFiles: [{ name: "local-a.jpg" } as File, { name: "local-b.jpg" } as File],
    collaborationTypes: ["Free Stay"],
    availability: ["January"],
    platforms: ["Instagram"],
    lookingForPlatforms: ["Instagram"],
    targetGroupCountries: ["Germany"],
  };
}
