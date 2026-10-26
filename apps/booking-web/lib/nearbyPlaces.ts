import {
  NEARBY_CATEGORY_ICONS,
  NEARBY_CUSTOM_CATEGORY_COLORS,
  NEARBY_DEFAULT_CATEGORIES,
  type NearbyCategoryView,
} from "@vayada/domain-hotels";
import { bookingWebPublic } from "@/services/api/client";

/** The host's nearby places on the guest map (VAY-2327), from the public nearby response: only the host's own
 * places (v1, VAY-2326 D5), in the host's order, with the categories guests filter by. */
export type GuestNearbyPlace = {
  id: string;
  name: string;
  category: NearbyCategoryView;
  latitude: number;
  longitude: number;
  note: string | null;
};

export type GuestNearby = {
  places: GuestNearbyPlace[];
  /** The categories the places use, in the host's order: the four standard ones, then the host's own. */
  categories: NearbyCategoryView[];
};

const COLORS: readonly string[] = [
  ...NEARBY_DEFAULT_CATEGORIES.map(({ color }) => color),
  ...NEARBY_CUSTOM_CATEGORY_COLORS,
];
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const coordinate = (value: unknown, limit: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;

/** The places guests may see, or none: anything but a ready response (the host's switch off, a hidden location,
 * no places) shows no nearby places. A place in a category the response doesn't describe is left out. */
export function parseGuestNearby(value: unknown): GuestNearby {
  const none = { places: [], categories: [] };
  if (!record(value) || value.schemaVersion !== 1 || value.status !== "ready") return none;
  if (!Array.isArray(value.places) || !Array.isArray(value.categories)) return none;
  const categories = new Map<string, NearbyCategoryView>();
  for (const item of value.categories)
    if (
      record(item) &&
      typeof item.id === "string" &&
      (item.name === null || typeof item.name === "string") &&
      typeof item.color === "string" &&
      COLORS.includes(item.color) &&
      typeof item.icon === "string" &&
      (NEARBY_CATEGORY_ICONS as readonly string[]).includes(item.icon)
    )
      categories.set(item.id, item as NearbyCategoryView);
  const places = value.places.flatMap((place): GuestNearbyPlace[] => {
    if (
      !record(place) ||
      place.source !== "custom" ||
      typeof place.id !== "string" ||
      typeof place.name !== "string" ||
      !place.name.trim() ||
      typeof place.category !== "string" ||
      !coordinate(place.latitude, 90) ||
      !coordinate(place.longitude, 180) ||
      (place.note !== null && typeof place.note !== "string")
    )
      return [];
    const category = categories.get(place.category);
    return category
      ? [
          {
            id: place.id,
            name: place.name,
            category,
            latitude: place.latitude,
            longitude: place.longitude,
            note: typeof place.note === "string" && place.note.trim() ? place.note : null,
          },
        ]
      : [];
  });
  const used = new Set(places.map(({ category }) => category.id));
  return { places, categories: Array.from(categories.values()).filter(({ id }) => used.has(id)) };
}

export async function fetchGuestNearby(slug: string, signal: AbortSignal): Promise<GuestNearby> {
  return parseGuestNearby(
    await bookingWebPublic.get<unknown>(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/nearby`,
      {
        cache: "no-store",
        signal,
      },
    ),
  );
}

/** The categories the guest turned off on the map, remembered for this browser tab only, like the view. */
const OFF_KEY = "vayada.booking.nearbyOff";

export function hiddenNearbyCategories(): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(OFF_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function hideNearbyCategories(ids: string[]): void {
  try {
    sessionStorage.setItem(OFF_KEY, JSON.stringify(ids));
  } catch {
    // Storage blocked: every category shows again on the next page.
  }
}

/** Google Maps directions to a place the host placed (their own content, VAY-2326). */
export function directionsUrl(place: Pick<GuestNearbyPlace, "latitude" | "longitude">): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${place.latitude},${place.longitude}`;
}
