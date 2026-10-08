import { parseRoomTypeFacts, type RoomTypeFacts } from "@vayada/domain-pms";

import type { RoomTypeCreate } from ".";

// The room form's bed and amenity labels, keyed to the canonical room-facts and room-amenity
// vocabularies (apps/api/src/domains/pmsRoomFactsVocabulary.ts, pmsRoomAmenityVocabulary.ts).
const BED_TYPE_KEYS: Record<string, string> = {
  "King Bed": "king",
  "Queen Bed": "queen",
  "Double Bed": "double",
  "Twin Bed": "twin",
  "Single Bed": "single",
  "Bunk Bed": "bunk_bed",
  "Sofa Bed": "sofa_bed",
};

const ROOM_AMENITY_KEYS: Record<string, string> = {
  "Free WiFi": "wifi",
  "Flat-screen TV": "flat_screen_tv",
  "Smart TV": "smart_tv",
  "Netflix / Streaming": "streaming_services",
  "Work desk": "work_desk",
  "Laptop-friendly workspace": "laptop_friendly_workspace",
  Minibar: "minibar",
  Refrigerator: "refrigerator",
  Microwave: "microwave",
  Kitchenware: "kitchenware",
  "Electric kettle": "electric_kettle",
  Stovetop: "stovetop",
  "Dining table": "dining_table",
  Bathtub: "bathtub",
  Shower: "shower",
  "Free toiletries": "free_toiletries",
  Hairdryer: "hairdryer",
  Toilet: "toilet",
  "Toilet paper": "toilet_paper",
  "Hot Tub": "hot_tub",
  Towels: "towels",
  Slippers: "slippers",
  Bathrobe: "bathrobe",
  "Air conditioning": "air_conditioning",
  Heating: "heating",
  Fan: "fan",
  Fireplace: "fireplace",
  "Extra pillows": "extra_pillows",
  "Blackout curtains": "blackout_curtains",
  Wardrobe: "wardrobe",
  "Bed linen": "bed_linen",
  "Washing machine": "washing_machine",
  Dryer: "dryer",
  "Iron/Ironing board": "iron_and_ironing_board",
  "Clothes rack": "clothes_rack",
  Safe: "in_room_safe",
  "Smoke detector": "smoke_detector",
  "First aid kit": "first_aid_kit",
  "Fire extinguisher": "fire_extinguisher",
  "Non-smoking": "non_smoking",
};
// A private bathroom is the bathroomType room fact, not an amenity.
const PRIVATE_BATHROOM_LABEL = "Private Bathroom";

const BED_TYPE_LABELS = Object.fromEntries(
  Object.entries(BED_TYPE_KEYS).map(([label, key]) => [key, label]),
);
const ROOM_AMENITY_LABELS = Object.fromEntries(
  Object.entries(ROOM_AMENITY_KEYS).map(([label, key]) => [key, label]),
);

export function roomTypeFactsFromForm(data: RoomTypeCreate): RoomTypeFacts {
  const maxGuests = data.maxOccupancy ?? 0;
  // A blank adult or child limit means "any", as the room-facts read model treats it.
  const maxAdults = data.maxAdults ?? maxGuests;
  const maxChildren = data.maxChildren ?? maxGuests;
  if (maxAdults < 1 || maxAdults > maxGuests || maxChildren > maxGuests) {
    throw new Error("Max adults and max children cannot exceed the maximum occupancy.");
  }
  if (maxAdults + maxChildren < maxGuests) {
    throw new Error("Max adults plus max children must add up to at least the maximum occupancy.");
  }
  const facts = parseRoomTypeFacts({
    name: data.name.trim(),
    description: data.description ?? "",
    category: data.category ? data.category.toLowerCase() : null,
    occupancy: { maxGuests, maxAdults, maxChildren },
    beds: bedsFromSummary(data.bedType ?? ""),
    bedrooms: data.bedrooms ?? null,
    bathrooms: data.bathroomType === "shared" ? null : (data.bathrooms ?? 1),
    bathroomType: data.bathroomType,
    size: data.size && data.size > 0 ? { value: data.size, unit: "sqm" } : null,
  });
  if (!facts) {
    throw new Error(
      "Check the room details: a name of up to 200 characters, a description of up to 5,000 characters, whole bed and bedroom counts, and at least one bathroom.",
    );
  }
  return facts;
}

export function roomAmenityKeys(labels: readonly string[]): string[] {
  const roomAmenities = labels.filter((label) => label !== PRIVATE_BATHROOM_LABEL);
  const unsupported = roomAmenities.filter((label) => !ROOM_AMENITY_KEYS[label]);
  if (unsupported.length > 0) {
    throw new Error(
      `${unsupported.join(", ")} can't be saved as room amenities. Remove them and try again.`,
    );
  }
  return Array.from(new Set(roomAmenities.map((label) => ROOM_AMENITY_KEYS[label]!))).sort();
}

export function bedSummaryFromFacts(beds: unknown): string | undefined {
  if (!Array.isArray(beds)) return undefined;
  return beds
    .map((bed: { type?: unknown; quantity?: unknown }) => {
      const type = String(bed?.type ?? "");
      return `${Number(bed?.quantity) || 1} ${BED_TYPE_LABELS[type] ?? type}`;
    })
    .join(", ");
}

// Room facts store lowercase category keys and the size as { value, unit }; older rows do not.
export function roomCategoryLabel(category: string | null): string {
  return category ? `${category.charAt(0).toUpperCase()}${category.slice(1)}` : "";
}

export function roomSizeValue(size: unknown): unknown {
  return size && typeof size === "object" ? (size as { value?: unknown }).value : size;
}

export function roomAmenityLabels(amenities: readonly string[]): string[] {
  return amenities.map((amenity) => ROOM_AMENITY_LABELS[amenity] ?? amenity);
}

function bedsFromSummary(summary: string): { type: string; quantity: number }[] {
  const quantities = new Map<string, number>();
  for (const part of summary.split(",").map((value) => value.trim())) {
    if (!part) continue;
    const match = /^(\d+)\s+(.+)$/.exec(part);
    const label = match ? match[2]! : part;
    const type = BED_TYPE_KEYS[label] ?? label;
    quantities.set(type, (quantities.get(type) ?? 0) + (match ? Number(match[1]) : 1));
  }
  return Array.from(quantities, ([type, quantity]) => ({ type, quantity }));
}
