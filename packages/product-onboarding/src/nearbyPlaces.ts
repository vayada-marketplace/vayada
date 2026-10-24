import {
  NEARBY_CATEGORIES,
  NEARBY_TIP_MAX_LENGTH,
  type NearbyCategoryColor,
  type NearbyCategoryView,
  type NearbyCuration,
  type NearbyCustomPlace,
} from "@vayada/domain-hotels";
import type { Translate } from "./nearbyPlacesMessages";

/** The nearby places editor's rules (VAY-2326), kept apart from its view so they can be tested. */

/** Own places per property; saved Google additions count too (none exist today). */
export const NEARBY_PLACE_LIMIT = 20;

/** The categories' colours, as the approved boards draw them. */
export const NEARBY_CATEGORY_HEX: Record<NearbyCategoryColor, string> = {
  orange: "#EA580C",
  teal: "#0D9488",
  purple: "#7C3AED",
  slate: "#475569",
  red: "#DC2626",
  amber: "#D97706",
  green: "#16A34A",
  sky: "#0284C7",
  indigo: "#4F46E5",
  pink: "#DB2777",
  stone: "#57534E",
};

type Point = { latitude: number; longitude: number };

/** A category's name: the host's own, or the standard name in the reader's language. */
export function nearbyCategoryName(category: NearbyCategoryView, t: Translate): string {
  return category.name ?? t(`nearbyPlaces.category.${category.id}`);
}

export function isStandardCategory(id: string): boolean {
  return (NEARBY_CATEGORIES as readonly string[]).includes(id);
}

/** Straight-line distance in kilometres (decision D5: no walking times). */
export function distanceKm(from: Point, to: Point): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(to.latitude - from.latitude);
  const dLng = radians(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** "1.4 km", with the reader's decimal mark. */
export function formatDistance(from: Point, to: Point, locale: string, t: Translate): string {
  const distance = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(distanceKm(from, to));
  return t("nearbyPlaces.distance", { distance });
}

/** The list with one item moved, for drag and the arrow keys. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Deleting one of the host's categories: its places move to another category, or go with it. */
export function deleteNearbyCategory(
  curation: Pick<NearbyCuration, "customPlaces" | "customCategories">,
  id: string,
  moveTo: string | null,
): Pick<NearbyCuration, "customPlaces" | "customCategories"> {
  return {
    customCategories: curation.customCategories.filter((category) => category.id !== id),
    customPlaces: curation.customPlaces.flatMap((place) =>
      place.category !== id ? [place] : moveTo ? [{ ...place, category: moveTo }] : [],
    ),
  };
}

/** A tip is fine up to 140 characters; a longer one saved before stays only as it was (VAY-2326). */
export function tipTooLong(note: string, saved: string | null | undefined): boolean {
  return note.trim().length > NEARBY_TIP_MAX_LENGTH && note.trim() !== (saved ?? "");
}

/** A new place with what the host typed: the name and tip trimmed, an empty tip left out. */
export function nearbyPlace(
  id: string,
  values: { name: string; category: string; note: string; latitude: number; longitude: number },
  previous?: NearbyCustomPlace,
): NearbyCustomPlace {
  return {
    id,
    category: values.category,
    name: values.name.trim(),
    address: previous?.address ?? null,
    latitude: values.latitude,
    longitude: values.longitude,
    favorite: previous?.favorite ?? false,
    hidden: previous?.hidden ?? false,
    note: values.note.trim() || null,
  };
}
