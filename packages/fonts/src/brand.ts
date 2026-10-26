import { cinzel, inter, italiana, lora, playfairDisplay, sourceSans3 } from "./brand.generated";

// The Design Studio font pairings (packages/domain-booking BOOKING_DESIGN_FONT_PAIRINGS), as CSS
// font-family values of our self-hosted files. The guest booking site and the staff previews
// both use this map, so a preview shows exactly what guests see. "Source Sans Pro" became its
// successor Source Sans 3 (VAY-2216). Without preloading, the browser only downloads the files
// the shown pairing actually renders.
export const BRAND_FONT_PAIRINGS = {
  "high-end-serif": { heading: playfairDisplay, body: sourceSans3 },
  "modern-minimalist": { heading: inter, body: inter },
  "grand-classic": { heading: lora, body: sourceSans3 },
  "imperial-serif": { heading: cinzel, body: sourceSans3 },
  "italiana-serif": { heading: italiana, body: sourceSans3 },
} as const;

export type BrandFontPairing = keyof typeof BRAND_FONT_PAIRINGS;

export function brandFontPairing(id: string | null | undefined) {
  return id && Object.hasOwn(BRAND_FONT_PAIRINGS, id)
    ? BRAND_FONT_PAIRINGS[id as BrandFontPairing]
    : undefined;
}
