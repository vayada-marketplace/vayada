import { Cinzel, Inter, Italiana, Lora, Playfair_Display, Source_Sans_3 } from "next/font/google";
import type { BookingDesignFontPairing } from "@vayada/domain-booking";

// Design Studio font pairings, served from our own origin: next/font downloads the files at
// build time, so a guest's browser never contacts Google (VAY-2216). Without preloading, the
// browser only downloads the families the hotel's pairing actually renders. The weights are the
// ones the pages had from Google; a variable font would also add the weights in between (e.g. a
// real 500 for font-medium, where the browser used to fall back to 400).
const playfairDisplay = Playfair_Display({
  weight: ["400", "700"],
  style: ["normal", "italic"],
  display: "swap",
  preload: false,
});
// Next has no "Source Sans Pro"; Source Sans 3 is its successor from the same designers.
const sourceSans = Source_Sans_3({
  weight: ["300", "400", "600", "700"],
  display: "swap",
  preload: false,
});
const inter = Inter({
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
  preload: false,
});
const lora = Lora({
  weight: ["400", "700"],
  style: ["normal", "italic"],
  display: "swap",
  preload: false,
});
const cinzel = Cinzel({ weight: ["400", "600", "700"], display: "swap", preload: false });
const italiana = Italiana({ weight: "400", display: "swap", preload: false });

const serif = (font: { style: { fontFamily: string } }) => `${font.style.fontFamily}, serif`;
const sans = (font: { style: { fontFamily: string } }) => `${font.style.fontFamily}, sans-serif`;

const BRAND_FONT_PAIRINGS: Record<BookingDesignFontPairing, { heading: string; body: string }> = {
  "high-end-serif": { heading: serif(playfairDisplay), body: sans(sourceSans) },
  "modern-minimalist": { heading: sans(inter), body: sans(inter) },
  "grand-classic": { heading: serif(lora), body: sans(sourceSans) },
  "imperial-serif": { heading: serif(cinzel), body: sans(sourceSans) },
  "italiana-serif": { heading: serif(italiana), body: sans(sourceSans) },
};

export function brandFontPairing(id: string | null | undefined) {
  return id && Object.hasOwn(BRAND_FONT_PAIRINGS, id)
    ? BRAND_FONT_PAIRINGS[id as BookingDesignFontPairing]
    : undefined;
}
