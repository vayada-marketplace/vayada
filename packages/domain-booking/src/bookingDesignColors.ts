/**
 * The booking page's button colours, kept apart from the design contract so the guest booking site
 * can use them without loading the whole Booking domain (VAY-2475).
 */
export const BOOKING_DESIGN_BUTTON_FOREGROUND_COLOR = "#FFFFFF" as const;
/** Button text on light brand colours, where white would be hard to read (VAY-2475). */
export const BOOKING_DESIGN_BUTTON_DARK_FOREGROUND_COLOR = "#000000" as const;

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
 * White wherever white text reaches the WCAG AA 4.5:1 contrast (the old rule, so no colour that
 * passed it changes), else black, which then always reaches at least 4.67:1 (VAY-2475).
 */
export function bookingDesignTextColorOn(backgroundColor: string) {
  return 1.05 / (relativeLuminance(backgroundColor) + 0.05) >= 4.5
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
