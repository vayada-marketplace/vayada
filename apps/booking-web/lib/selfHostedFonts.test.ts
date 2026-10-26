import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  BOOKING_DESIGN_FONT_PAIRINGS,
  type BookingDesignFontPairing,
} from "@vayada/domain-booking";

type LocalFontOptions = {
  src: { path: string; weight: string; style: string }[];
  declarations: { prop: string; value: string }[];
  preload: boolean;
  adjustFontFallback: string | false;
};

// next/font only works inside Next's compiler; stand in a family named after each call's first
// file (without "-italic").
const { calls } = vi.hoisted(() => ({ calls: [] as LocalFontOptions[] }));
vi.mock("next/font/local", () => ({
  default: (options: LocalFontOptions) => {
    calls.push(options);
    const family = path.basename(options.src[0]!.path, ".woff2").replace(/-italic$/, "");
    return { style: { fontFamily: `'${family}'` } };
  },
}));

import { BRAND_FONT_PAIRINGS, brandFontPairing } from "@vayada/fonts/brand";
import { uiFontFamily } from "@vayada/fonts/ui";

// A Design Studio pairing without fonts fails the typecheck.
const everyPairing: Record<BookingDesignFontPairing, unknown> = BRAND_FONT_PAIRINGS;

const requireFrom = createRequire(import.meta.url);
const fontsRoot = path.join(path.dirname(requireFrom.resolve("@vayada/fonts/brand")), "..");
const firstFamily = (stack: string) => stack.split(", ")[0]!.replace(/'/g, "");

describe("self-hosted fonts (no Google Fonts at build time or in the browser)", () => {
  it.each(Object.entries(BOOKING_DESIGN_FONT_PAIRINGS))(
    "renders %s with the Design Studio families",
    (id, design) => {
      const slug = (family: string) =>
        family.split(",")[0]!.replace(/'/g, "").replace("Source Sans Pro", "Source Sans 3");
      const pairing = brandFontPairing(id)!;
      expect(firstFamily(pairing.heading)).toBe(
        `${slug(design.headingFamily).toLowerCase().replace(/ /g, "-")}-latin`,
      );
      expect(firstFamily(pairing.body)).toBe(
        `${slug(design.bodyFamily).toLowerCase().replace(/ /g, "-")}-latin`,
      );
      expect(everyPairing[id as BookingDesignFontPairing]).toBe(pairing);
    },
  );

  it.each([null, undefined, "", "unknown", "constructor", "toString"])("ignores %s", (id) => {
    expect(brandFontPairing(id)).toBeUndefined();
  });

  it("chains a family's subsets latin first, then its fallback and generic family", () => {
    expect(brandFontPairing("high-end-serif")).toEqual({
      heading:
        "'playfair-display-latin', 'playfair-display-latin-ext', 'playfair-display-vietnamese', " +
        "'playfair-display-cyrillic', \"Playfair Display Fallback\", serif",
      body:
        "'source-sans-3-latin', 'source-sans-3-latin-ext', 'source-sans-3-vietnamese', " +
        "'source-sans-3-greek', 'source-sans-3-greek-ext', 'source-sans-3-cyrillic', " +
        "'source-sans-3-cyrillic-ext', \"Source Sans 3 Fallback\", sans-serif",
    });
    expect(brandFontPairing("italiana-serif")?.heading).toBe(
      "'italiana-latin', \"Italiana Fallback\", serif",
    );
    // next/font/google's Inter({ subsets: ["latin"] }) had no generic family either.
    expect(uiFontFamily).toBe(
      "'inter-latin', 'inter-latin-ext', 'inter-vietnamese', 'inter-greek', 'inter-greek-ext', " +
        "'inter-cyrillic', 'inter-cyrillic-ext', \"Inter Fallback\"",
    );
  });

  it("loads committed files, one unicode-range each, and preloads only the UI latin file", () => {
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      for (const { path: file } of call.src)
        expect(existsSync(path.join(fontsRoot, "src", file))).toBe(true);
      expect(call.declarations).toEqual([
        { prop: "unicode-range", value: expect.stringMatching(/^U\+/) },
      ]);
      expect(call.adjustFontFallback).toBe(false);
    }
    expect(calls.filter((call) => call.preload).map((call) => call.src[0]!.path)).toEqual([
      "../files/inter-latin.woff2",
    ]);
  });

  it("commits the files that SOURCES.txt lists", () => {
    const sources = readFileSync(path.join(fontsRoot, "files", "SOURCES.txt"), "utf8")
      .trim()
      .split("\n");
    expect(sources).toHaveLength(39);
    for (const line of sources) {
      const [sha256, file] = line.split("  ");
      const bytes = readFileSync(path.join(fontsRoot, "files", file!));
      expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(sha256);
    }
  });

  it("keeps next/font/google's fallback faces", () => {
    const { calculateSizeAdjustValues } = requireFrom("next/dist/server/font-utils") as {
      calculateSizeAdjustValues: (family: string) => Record<string, string>;
    };
    const css = readFileSync(path.join(fontsRoot, "src", "fallbacks.css"), "utf8");
    const faces = Array.from(css.matchAll(/@font-face \{([^}]*)\}/g)).map(([, body]) => {
      const value = (prop: string) => new RegExp(`${prop}: ([^;]+);`).exec(body!)![1]!;
      return {
        family: value("font-family")
          .replace(/"/g, "")
          .replace(/ Fallback$/, ""),
        local: value("src"),
        numbers: ["ascent-override", "descent-override", "line-gap-override", "size-adjust"].map(
          (prop) => parseFloat(value(prop)),
        ),
      };
    });
    expect(faces.map((face) => face.family)).toEqual([
      "Playfair Display",
      "Source Sans 3",
      "Inter",
      "Lora",
      "Cinzel",
      "Italiana",
    ]);
    for (const face of faces) {
      const google = calculateSizeAdjustValues(face.family);
      expect(face.local).toBe(`local("${google.fallbackFont}")`);
      expect(face.numbers).toEqual(
        [google.ascent, google.descent, google.lineGap, google.sizeAdjust].map(Number),
      );
    }
  });
});
