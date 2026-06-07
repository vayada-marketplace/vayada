import type { Hotel, RoomType } from "@/lib/types";

type JsonLdValue =
  | string
  | number
  | boolean
  | null
  | JsonLdValue[]
  | { [key: string]: JsonLdValue | undefined };

type JsonLdObject = { [key: string]: JsonLdValue | undefined };

export const BOOKING_WEB_STRUCTURED_DATA_ID = "booking-web-public-structured-data";

export function buildPublicHotelStructuredData(input: {
  hotel: Hotel;
  rooms: RoomType[];
  locale: string;
}): JsonLdObject {
  const { hotel, rooms, locale } = input;
  const canonicalUrl = normalizedAbsoluteUrl(hotel.canonicalUrl, hotel.bookingBaseUrl);
  const roomNodes = rooms.map((room) => buildRoomNode({ hotel, room, canonicalUrl }));

  return stripUndefined({
    "@context": "https://schema.org",
    "@graph": [buildHotelNode({ hotel, canonicalUrl, locale, rooms }), ...roomNodes],
  });
}

function buildHotelNode(input: {
  hotel: Hotel;
  canonicalUrl: string;
  locale: string;
  rooms: RoomType[];
}): JsonLdObject {
  const { hotel, canonicalUrl, locale, rooms } = input;
  const images = uniqueUrls([hotel.heroImage, ...(hotel.images || [])], hotel.bookingBaseUrl);
  const publicRooms = rooms.map((room) => ({ "@id": roomId(canonicalUrl, room.id) }));

  return stripUndefined({
    "@type": "Hotel",
    "@id": hotelId(canonicalUrl),
    url: canonicalUrl,
    name: hotel.name,
    description: hotel.description,
    inLanguage: locale,
    image: images,
    starRating:
      hotel.starRating > 0
        ? {
            "@type": "Rating",
            ratingValue: hotel.starRating,
          }
        : undefined,
    address: buildPostalAddress(hotel),
    telephone: hotel.contact?.phone || undefined,
    email: hotel.contact?.email || undefined,
    amenityFeature: hotel.amenities.map((amenity) => ({
      "@type": "LocationFeatureSpecification",
      name: amenity,
      value: true,
    })),
    checkinTime: hotel.checkInTime || undefined,
    checkoutTime: hotel.checkOutTime || undefined,
    containsPlace: publicRooms.length > 0 ? publicRooms : undefined,
  });
}

function buildRoomNode(input: {
  hotel: Hotel;
  room: RoomType;
  canonicalUrl: string;
}): JsonLdObject {
  const { hotel, room, canonicalUrl } = input;
  const url = `${canonicalUrl}#room-${encodeURIComponent(room.id)}`;
  const bookableOffer = hotel.instantBook === true && room.remainingRooms > 0;

  return stripUndefined({
    "@type": "HotelRoom",
    "@id": roomId(canonicalUrl, room.id),
    url,
    name: room.name,
    description: room.description || room.shortDescription,
    image: uniqueUrls(room.images || [], hotel.bookingBaseUrl),
    bed: room.bedType || undefined,
    floorSize:
      room.size > 0
        ? {
            "@type": "QuantitativeValue",
            value: room.size,
            unitCode: "MTK",
          }
        : undefined,
    occupancy:
      room.maxOccupancy > 0
        ? {
            "@type": "QuantitativeValue",
            maxValue: room.maxOccupancy,
          }
        : undefined,
    amenityFeature: room.amenities.map((amenity) => ({
      "@type": "LocationFeatureSpecification",
      name: amenity,
      value: true,
    })),
    containedInPlace: { "@id": hotelId(canonicalUrl) },
    offers: bookableOffer ? buildRoomOffer({ room, url }) : undefined,
  });
}

function buildRoomOffer(input: { room: RoomType; url: string }): JsonLdObject | undefined {
  const { room, url } = input;
  if (room.baseRate <= 0 || !room.currency) {
    return undefined;
  }

  return {
    "@type": "Offer",
    url,
    price: room.baseRate,
    priceCurrency: room.currency,
    availability: "https://schema.org/InStock",
  };
}

function buildPostalAddress(hotel: Hotel): JsonLdObject {
  return stripUndefined({
    "@type": "PostalAddress",
    streetAddress: hotel.contact?.address || undefined,
    addressLocality: hotel.location || undefined,
    addressCountry: hotel.country || undefined,
  });
}

function hotelId(canonicalUrl: string): string {
  return `${canonicalUrl}#hotel`;
}

function roomId(canonicalUrl: string, roomIdValue: string): string {
  return `${canonicalUrl}#room-${encodeURIComponent(roomIdValue)}`;
}

function uniqueUrls(values: string[], baseUrl: string): string[] {
  return Array.from(
    new Set(values.map((value) => normalizedAbsoluteUrl(value, baseUrl)).filter(Boolean)),
  );
}

function normalizedAbsoluteUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function stripUndefined<T extends JsonLdObject>(value: T): T {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => [
        key,
        Array.isArray(entryValue)
          ? entryValue.map((item) =>
              item && typeof item === "object" ? stripUndefined(item as JsonLdObject) : item,
            )
          : entryValue && typeof entryValue === "object"
            ? stripUndefined(entryValue as JsonLdObject)
            : entryValue,
      ]),
  ) as T;
}
