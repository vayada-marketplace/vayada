import { bookingDesignTextColorOn } from "@vayada/domain-booking/design-colors";

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (c: number) =>
    Math.round(Math.max(0, Math.min(255, c)))
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function mix(base: Rgb, target: Rgb, t: number): string {
  return rgbToHex(
    base[0] + (target[0] - base[0]) * t,
    base[1] + (target[1] - base[1]) * t,
    base[2] + (target[2] - base[2]) * t,
  );
}

export function generateColorPalette(hex: string): Record<string, string> {
  const base = hexToRgb(hex);
  const white: Rgb = [255, 255, 255];
  const black: Rgb = [0, 0, 0];

  return {
    "50": mix(base, white, 0.95),
    "100": mix(base, white, 0.88),
    "200": mix(base, white, 0.75),
    "300": mix(base, white, 0.55),
    "400": mix(base, white, 0.25),
    "500": hex,
    "600": mix(base, black, 0.12),
    "700": mix(base, black, 0.28),
    "800": mix(base, black, 0.45),
    "900": mix(base, black, 0.65),
  };
}

/**
 * The text colour on the primary-600 and primary-700 shades, as "r g b" for Tailwind's
 * `text-primary-on-600` / `text-primary-on-700`: white, or dark on a light brand colour, so buttons
 * stay readable with any brand colour (VAY-2475).
 */
export function generateOnColorPalette(hex: string): Record<"on-600" | "on-700", string> {
  const palette = generateColorPalette(hex);
  const channels = (shade: string) => hexToRgb(bookingDesignTextColorOn(shade)).join(" ");
  return { "on-600": channels(palette["600"]!), "on-700": channels(palette["700"]!) };
}
