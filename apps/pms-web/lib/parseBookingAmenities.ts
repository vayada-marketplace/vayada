export interface AmenityCategory {
  name: string
  items: string[]
}

export interface ParsedAmenitiesResult {
  matched: { amenity: string; category: string }[]
  unmatched: string[]
}

// Maps Booking.com (and similar OTA) amenity vocabulary to our canonical labels.
// Keys are normalized (lowercase, trimmed) — see normalize().
const ALIASES: Record<string, string> = {
  // Internet & Tech
  'desk': 'Work desk',
  'work desk': 'Work desk',
  'laptop friendly workspace': 'Laptop-friendly workspace',
  'streaming service': 'Netflix / Streaming',
  'streaming service like netflix': 'Netflix / Streaming',
  'netflix': 'Netflix / Streaming',
  'tv': 'Flat-screen TV',
  'cable channels': 'Flat-screen TV',
  'satellite channels': 'Flat-screen TV',
  'pay per view channels': 'Flat-screen TV',
  'wifi': 'Free WiFi',
  'wi fi': 'Free WiFi',
  'free wifi': 'Free WiFi',
  'internet': 'Free WiFi',

  // Kitchen
  'kitchen': 'Kitchenware',
  'kitchenette': 'Kitchenware',
  'tea coffee maker': 'Electric kettle',
  'coffee machine': 'Electric kettle',
  'kettle': 'Electric kettle',
  'oven': 'Stovetop',
  'cooker': 'Stovetop',
  'fridge': 'Refrigerator',
  'mini bar': 'Minibar',

  // Bathroom
  'private bathroom': 'Private Bathroom',
  'hairdryer': 'Hairdryer',
  'hair dryer': 'Hairdryer',
  'free toiletries': 'Free toiletries',
  'toiletries': 'Free toiletries',
  'bathtub': 'Bath',
  'spa tub': 'Hot Tub',
  'hot tub': 'Hot Tub',

  // Climate & Comfort
  'air conditioning': 'Air conditioning',
  'air conditioner': 'Air conditioning',
  'ac': 'Air conditioning',
  'single room air conditioning for guest accommodation': 'Air conditioning',

  // Bedroom
  'linen': 'Bed linen',
  'bed linens': 'Bed linen',
  'bed linen': 'Bed linen',
  'blackout curtains': 'Blackout curtains',
  'extra pillows': 'Extra pillows',
  'wardrobe or closet': 'Wardrobe',
  'wardrobe': 'Wardrobe',
  'closet': 'Wardrobe',

  // Laundry
  'washing machine': 'Washing machine',
  'tumble dryer': 'Dryer',
  'clothes dryer': 'Dryer',
  'iron': 'Iron/Ironing board',
  'ironing facilities': 'Iron/Ironing board',
  'ironing board': 'Iron/Ironing board',
  'drying rack for clothing': 'Clothes rack',
  'clothes rack': 'Clothes rack',

  // Safety & Access
  'safe': 'Safe',
  'safety deposit box': 'Safe',
  'in room safe': 'Safe',
  '24 hour security': '24hr Security',
  '24hr security': '24hr Security',
  'security': '24hr Security',
  'smoke alarms': 'Smoke detector',
  'smoke detector': 'Smoke detector',
  'first aid kit': 'First aid kit',
  'fire extinguishers': 'Fire extinguisher',
  'fire extinguisher': 'Fire extinguisher',

  // Services
  'room service': 'Room service',
  'daily housekeeping': 'Daily housekeeping',
  'daily maid service': 'Daily housekeeping',
  'housekeeping': 'Daily housekeeping',
  'concierge service': 'Concierge',
  'concierge': 'Concierge',
  'free parking': 'Parking',
  'private parking': 'Parking',
  'parking': 'Parking',
  'non smoking rooms': 'Non-smoking',
  'non smoking': 'Non-smoking',
  'adults only': 'Adults-Only',
}

// Strips checkmarks, bullets, leading punctuation, and parenthetical asides;
// lowercases; collapses whitespace; removes non-word chars except spaces.
function normalize(raw: string): string {
  return raw
    .replace(/[✓✔✅•●◦\-\*•·]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseBookingAmenities(
  input: string,
  categories: AmenityCategory[]
): ParsedAmenitiesResult {
  // Build a normalized → canonical lookup from the canonical list itself,
  // so exact (case-insensitive) matches always win.
  const canonicalByNorm = new Map<string, { amenity: string; category: string }>()
  for (const cat of categories) {
    for (const item of cat.items) {
      canonicalByNorm.set(normalize(item), { amenity: item, category: cat.name })
    }
  }

  // Reverse lookup canonical → category, used for alias hits.
  const categoryFor = new Map<string, string>()
  for (const cat of categories) {
    for (const item of cat.items) categoryFor.set(item, cat.name)
  }

  const matched: { amenity: string; category: string }[] = []
  const unmatched: string[] = []
  const seen = new Set<string>()

  const lines = input
    .split(/\r?\n|;|,(?=\s*[A-Z])/)
    .map(l => l.trim())
    .filter(Boolean)

  for (const line of lines) {
    const norm = normalize(line)
    if (!norm) continue

    let canonical: string | undefined
    let category: string | undefined

    const direct = canonicalByNorm.get(norm)
    if (direct) {
      canonical = direct.amenity
      category = direct.category
    } else if (ALIASES[norm]) {
      canonical = ALIASES[norm]
      category = categoryFor.get(canonical)
    }

    if (canonical && category) {
      if (seen.has(canonical)) continue
      seen.add(canonical)
      matched.push({ amenity: canonical, category })
    } else {
      // Preserve the original line (cleaned of leading checkmarks) as the unmatched label.
      const cleaned = line.replace(/^[✓✔✅•●◦\-\*•·\s]+/, '').trim()
      if (cleaned) unmatched.push(cleaned)
    }
  }

  return { matched, unmatched }
}
