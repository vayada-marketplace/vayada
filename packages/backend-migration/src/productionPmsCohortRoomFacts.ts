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

/** A bed label as a key: the form's label or vocabulary key (also plural), else the native
 * legacy read's slug (pmsRoomFactsReadModel legacyBeds), which an owner can then correct. */
function bedKey(label: string): string {
  const text = label.trim().toLowerCase();
  return (
    BED_KEYS.get(text) ??
    BED_KEYS.get(text.replace(/s$/, "")) ??
    text.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  );
}

/**
 * VAY-1362: a legacy room type's facts in the native room-facts contract, mapped as the PMS room
 * form maps its fields (apps/pms-web roomTypeFactsFromForm): blank adult and child limits mean
 * the total, the category and bed labels map to the native vocabulary (an unknown bed label to
 * the native legacy read's slug), a size of 0 is none, and the bathroom is private as the form's
 * default, or shared without a bathroom count (legacy records no bathroom type). Null when the
 * legacy row cannot be expressed without guessing (no bed, limits the contract refuses); the
 * room type then keeps its legacy shape, which parity reports (COHORT_SCOPE_VERIFIED).
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
    const key = bedKey(match ? match[2]! : text);
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
    bathroomType: bathrooms > 0 ? "private" : "shared",
    size: Number.isFinite(size) && size > 0 ? { value: size, unit: "sqm" } : null,
  });
  return facts ? { facts, legacyCategory: category ? null : categoryText } : null;
}

/**
 * The stored columns the native room-facts writer sets (pmsRoomFactsCommandRepository
 * occupancyPayload and roomAttributesPayload). The legacy copies of the same facts move under
 * legacyRoomFacts: native edits merge new keys in, and readers that prefer the legacy keys
 * (maxOccupancy, bedType) would otherwise keep showing stale values.
 */
export function nativeRoomFactColumns(
  facts: RoomTypeFacts,
  legacy: { occupancyLimits: Record<string, unknown>; roomAttributes: Record<string, unknown> },
  legacyCategory: string | null,
) {
  const {
    bedType,
    size,
    bedrooms: _bedrooms,
    bathrooms: _bathrooms,
    ...attributes
  } = legacy.roomAttributes;
  return {
    category: facts.category,
    occupancyLimits: {
      total: facts.occupancy.maxGuests,
      adults: facts.occupancy.maxAdults,
      children: facts.occupancy.maxChildren,
    },
    roomAttributes: {
      ...attributes,
      beds: facts.beds,
      bedrooms: facts.bedrooms,
      bathrooms: facts.bathrooms,
      bathroomType: facts.bathroomType,
      size: facts.size,
      legacyRoomFacts: {
        ...legacy.occupancyLimits,
        bedType,
        size,
        ...(legacyCategory ? { category: legacyCategory } : {}),
      },
    },
  };
}
