import { describe, expect, it } from "vitest";

import { generateColorPalette, generateOnColorPalette } from "./colors";

describe("generateOnColorPalette (VAY-2475)", () => {
  it("gives light brand colours dark button text, as r g b channels", () => {
    // Aether Hilltop Villas: dark on its button shade, white on the darker confirmation buttons.
    expect(generateOnColorPalette("#c19a76")).toEqual({
      "on-600": "17 24 39",
      "on-700": "255 255 255",
    });
    expect(generateOnColorPalette("#F5F5F5")).toEqual({
      "on-600": "17 24 39",
      "on-700": "17 24 39",
    });
  });

  it("keeps white button text on the setup colours", () => {
    for (const colour of ["#4F46E5", "#0077B6", "#2D6A4F", "#7B2D8E", "#2D3436"])
      expect(generateOnColorPalette(colour), colour).toEqual({
        "on-600": "255 255 255",
        "on-700": "255 255 255",
      });
  });

  it("leaves the brand shades themselves unchanged", () => {
    expect(generateColorPalette("#c19a76")).toMatchObject({
      "500": "#c19a76",
      "600": "#aa8868",
      "700": "#8b6f55",
    });
  });
});
