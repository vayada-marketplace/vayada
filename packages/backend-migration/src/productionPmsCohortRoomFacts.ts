import { parseRoomTypeFacts, type RoomTypeFacts } from "@vayada/domain-pms";

import { integer, optionalText } from "./productionBookingValues.js";

/** The native room-facts vocabulary (apps/api pmsRoomFactsVocabulary.ts). */
export const NATIVE_ROOM_CATEGORIES = new Set([
  "standard", "deluxe", "superior", "suite", "villa", "bungalow", "studio", "penthouse",
]); // prettier-ignore
export const NATIVE_BED_TYPES = new Set([
  "king", "queen", "double", "twin", "single", "bunk_bed", "sofa_bed",
]); // prettier-ignore
/** The room form's bed labels (apps/pms-web services/rooms/roomFacts.ts BED_TYPE_KEYS). */
export const NATIVE_BED_LABELS: Record<string, string> = {
  "King Bed": "king",
  "Queen Bed": "queen",
  "Double Bed": "double",
  "Twin Bed": "twin",
  "Single Bed": "single",
  "Bunk Bed": "bunk_bed",
  "Sofa Bed": "sofa_bed",
};
const BED_KEYS = new Map([
  ...Object.entries(NATIVE_BED_LABELS).map(([label, key]) => [label.toLowerCase(), key] as const),
  ...[...NATIVE_BED_TYPES].map((key) => [key, key] as const),
]);

/**
 * VAY-1362: a legacy room type's facts in the native room-facts contract, mapped as the PMS room
 * form maps its fields (apps/pms-web roomTypeFactsFromForm): blank adult and child limits mean
 * the total, the category and bed labels map to the native vocabulary, a size of 0 is none, and
 * the bathroom is private (the form's default; legacy records no bathroom type). Null when the
 * legacy row cannot be expressed without guessing (an unknown bed label, no bed, limits the
 * contract refuses); the room type then keeps its legacy shape and its hotel stays in setup.
 */
export function cohortRoomFacts(data: Record<string, unknown>): {
  facts: RoomTypeFacts;
  legacyCategory: string | null;
} | null {
  const maxGuests = integer(data["max_occupancy"], "max_occupancy", 2);
  const limit = (field: string) =>
    data[field] === null || data[field] === undefined || data[field] === ""
      ? maxGuests
      : integer(data[field], field);
  const categoryText = optionalText(data["category"], "category");
  const category =
    categoryText && NATIVE_ROOM_CATEGORIES.has(categoryText.toLowerCase())
      ? categoryText.toLowerCase()
      : null;
  const beds = new Map<string, number>();
  for (const part of String(data["bed_type"] ?? "").split(",")) {
    const text = part.trim();
    if (!text) continue;
    const match = /^(\d+)\s+(.+)$/.exec(text);
    const key = BED_KEYS.get((match ? match[2]! : text).trim().toLowerCase());
    if (!key) return null;
    beds.set(key, (beds.get(key) ?? 0) + (match ? Number(match[1]) : 1));
  }
  const bathrooms = integer(data["bathrooms"], "bathrooms", 1);
  const size = Number(data["size"] ?? 0);
  const facts = parseRoomTypeFacts({
    name: String(data["name"] ?? "").trim(),
    description: optionalText(data["description"], "description") ?? "",
    category,
    occupancy: {
      maxGuests,
      maxAdults: limit("max_adults"),
      maxChildren: limit("max_children"),
    },
    beds: [...beds].map(([type, quantity]) => ({ type, quantity })),
    bedrooms: integer(data["bedrooms"], "bedrooms", 1),
    bathrooms: bathrooms > 0 ? bathrooms : null,
    bathroomType: "private",
    size: Number.isFinite(size) && size > 0 ? { value: size, unit: "sqm" } : null,
  });
  return facts ? { facts, legacyCategory: category ? null : categoryText } : null;
}

/** The stored columns the native room-facts writer sets (pmsRoomFactsCommandRepository). */
export function nativeRoomFactColumns(
  facts: RoomTypeFacts,
  legacy: { occupancyLimits: Record<string, unknown>; roomAttributes: Record<string, unknown> },
  legacyCategory: string | null,
) {
  return {
    category: facts.category,
    occupancyLimits: {
      ...legacy.occupancyLimits,
      total: facts.occupancy.maxGuests,
      adults: facts.occupancy.maxAdults,
      children: facts.occupancy.maxChildren,
    },
    roomAttributes: {
      ...legacy.roomAttributes,
      beds: facts.beds,
      bedrooms: facts.bedrooms,
      bathrooms: facts.bathrooms,
      bathroomType: facts.bathroomType,
      size: facts.size,
      ...(legacyCategory ? { legacyCategory } : {}),
    },
  };
}
