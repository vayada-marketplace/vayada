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
    bedrooms: 1,
    bathrooms: null,
    amenities: ["Wi-Fi", "Air conditioning", "Bathtub", "Rooftop terrace"],
  });
  // Legacy rooms saved the size as a plain number of square metres and a free-text category.
  expect(roomCardFacts({ category: " Double ", attributes: { size: 18 }, amenities: [] })).toEqual({
    size: { value: 18, unit: "sqm" },
    category: "Double",
    bedrooms: null,
    bathrooms: null,
    amenities: [],
  });
});

it("reads bedrooms and bathrooms for the room details (VAY-2410)", () => {
  const facts = (bedrooms: unknown, bathrooms: unknown) => {
    const read = roomCardFacts({
      category: null,
      attributes: { bedrooms, bathrooms },
      amenities: [],
    });
    return [read.bedrooms, read.bathrooms];
  };
  expect(facts(4, 3)).toEqual([4, 3]);
  expect(facts(2, 1.5)).toEqual([2, 1.5]);
  // A studio has no bedroom to show; a shared bathroom is saved as none.
  expect(facts(0, null)).toEqual([null, null]);
  expect(facts(1.5, 1.25)).toEqual([null, 1.25]);
  expect(facts("2", "1")).toEqual([null, null]);
  expect(facts(101, -1)).toEqual([null, null]);
});

it("leaves out what the card can't show", () => {
  expect(
    roomCardFacts({
      category: null,
      attributes: { size: { value: 300, unit: "sqft" } },
      amenities: [3, "", "x".repeat(81)],
    }),
  ).toEqual({ size: null, category: null, bedrooms: null, bathrooms: null, amenities: [] });
  expect(roomCardFacts({ category: "", attributes: null, amenities: "wifi" })).toEqual({
    size: null,
    category: null,
    bedrooms: null,
    bathrooms: null,
    amenities: [],
  });
});
