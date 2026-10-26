import { expect, it } from "vitest";
import { roomCardFacts } from "./publicPricingOfferCatalog.js";

it("reads the room cards' size, category and amenity labels (VAY-2190)", () => {
  expect(
    roomCardFacts({
      category: "family_room",
      attributes: { size: { value: 32.5, unit: "sqm" }, bedrooms: 1 },
      amenities: ["wifi", "bathtub", "air_conditioning", "Rooftop terrace"],
    }),
  ).toEqual({
    size: { value: 32.5, unit: "sqm" },
    category: "Family room",
    amenities: ["Wi-Fi", "Air conditioning", "Bathtub", "Rooftop terrace"],
  });
  // Legacy rooms saved the size as a plain number of square metres and a free-text category.
  expect(roomCardFacts({ category: " Double ", attributes: { size: 18 }, amenities: [] })).toEqual({
    size: { value: 18, unit: "sqm" },
    category: "Double",
    amenities: [],
  });
});

it("leaves out what the card can't show", () => {
  expect(
    roomCardFacts({
      category: null,
      attributes: { size: { value: 300, unit: "sqft" } },
      amenities: [3, "", "x".repeat(81)],
    }),
  ).toEqual({ size: null, category: null, amenities: [] });
  expect(roomCardFacts({ category: "", attributes: null, amenities: "wifi" })).toEqual({
    size: null,
    category: null,
    amenities: [],
  });
});
