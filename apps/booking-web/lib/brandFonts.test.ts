import { describe, expect, it, vi } from "vitest";
import { BOOKING_DESIGN_FONT_PAIRINGS } from "@vayada/domain-booking";

// next/font only works inside Next's compiler; stand in a family named after each loader.
vi.mock("next/font/google", () => {
  const loader = (name: string) => () => ({
    style: { fontFamily: `'${name.replaceAll("_", " ")}'` },
  });
  return Object.fromEntries(
    ["Cinzel", "Inter", "Italiana", "Lora", "Playfair_Display", "Source_Sans_3"].map((name) => [
      name,
      loader(name),
    ]),
  );
});

import { brandFontPairing } from "./brandFonts";

describe("self-hosted Design Studio fonts", () => {
  it.each(Object.entries(BOOKING_DESIGN_FONT_PAIRINGS))(
    "serves %s with the Design Studio families",
    (id, design) => {
      expect(brandFontPairing(id)).toEqual({
        heading: design.headingFamily,
        body: design.bodyFamily.replace("Source Sans Pro", "Source Sans 3"),
      });
    },
  );

  it.each([null, undefined, "", "unknown", "constructor", "toString"])("ignores %s", (id) => {
    expect(brandFontPairing(id)).toBeUndefined();
  });
});
