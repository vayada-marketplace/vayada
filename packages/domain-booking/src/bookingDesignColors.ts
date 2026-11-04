/**
 * The booking page's button colours, kept apart from the design contract so the guest booking site
 * can use them without loading the whole Booking domain (VAY-2475).
 */
export const BOOKING_DESIGN_BUTTON_FOREGROUND_COLOR = "#FFFFFF" as const;
/** Button text on light brand colours, where white would be hard to read (VAY-2475). */
export const BOOKING_DESIGN_BUTTON_DARK_FOREGROUND_COLOR = "#111827" as const;

/** Matches Booking Web's primary-600/default and primary-700/hover palette tokens. */
export function createBookingDesignButtonColors(primaryColor: string) {
  const backgroundColor = mixWithBlack(primaryColor, 0.12);
  return Object.freeze({
    backgroundColor,
    hoverBackgroundColor: mixWithBlack(primaryColor, 0.28),
    foregroundColor: bookingDesignTextColorOn(backgroundColor),
  });
}

/**
 * White, or dark text when that reads better on the background (VAY-2475). Every colour that kept
 * white button text before stays white: white wins whenever it reaches about 4.2:1.
 */
export function bookingDesignTextColorOn(backgroundColor: string) {
  const background = relativeLuminance(backgroundColor);
  const white = 1.05 / (background + 0.05);
  const dark =
    (background + 0.05) / (relativeLuminance(BOOKING_DESIGN_BUTTON_DARK_FOREGROUND_COLOR) + 0.05);
  return white >= dark
    ? BOOKING_DESIGN_BUTTON_FOREGROUND_COLOR
    : BOOKING_DESIGN_BUTTON_DARK_FOREGROUND_COLOR;
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function mixWithBlack(hex: string, amount: number): string {
  const component = (offset: number) =>
    Math.round(Number.parseInt(hex.slice(offset, offset + 2), 16) * (1 - amount))
      .toString(16)
      .padStart(2, "0");
  return `#${component(1)}${component(3)}${component(5)}`;
}
