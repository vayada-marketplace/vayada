import { describe, expect, it } from "vitest";

import type { Hotel, RoomType } from "@/lib/types";

import { buildPublicHotelStructuredData } from "./structuredData";

const hotel = {
  name: "Hotel Alpenrose",
  description: "A warm alpine retreat.",
  canonicalUrl: "https://alpenrose.booking.vayada.com/en",
  bookingBaseUrl: "https://alpenrose.booking.vayada.com",
  heroImage: null,
  images: [],
  starRating: 0,
  amenities: [],
  location: "Munich",
  country: "Germany",
  checkInTime: "15:00",
  checkOutTime: "11:00",
} as unknown as Hotel;

const room = {
  id: "classic",
  name: "Classic Double",
  images: [],
  amenities: [],
  size: 0,
  maxOccupancy: 2,
} as unknown as RoomType;

function nodes(input: Hotel, rooms: RoomType[] = []) {
  return buildPublicHotelStructuredData({ hotel: input, rooms, locale: "en" })["@graph"] as Array<
    Record<string, unknown>
  >;
}

describe("public structured data without photos (VAY-2247)", () => {
  it("leaves the hotel and room image out when there are no photos", () => {
    const [hotelNode, roomNode] = nodes(hotel, [room]);
    expect(hotelNode).not.toHaveProperty("image");
    expect(roomNode).not.toHaveProperty("image");
  });

  it("publishes the hero first, then the gallery, as absolute URLs without duplicates", () => {
    const [hotelNode] = nodes({
      ...hotel,
      heroImage: "/hero.jpg",
      images: ["/hero.jpg", "/pool.jpg"],
    });
    expect(hotelNode.image).toEqual([
      "https://alpenrose.booking.vayada.com/hero.jpg",
      "https://alpenrose.booking.vayada.com/pool.jpg",
    ]);
  });
});
