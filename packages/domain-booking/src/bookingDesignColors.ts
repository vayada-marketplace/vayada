/**
 * The booking page's button colours, kept apart from the design contract so browser code can use
 * them without loading the whole Booking domain (`@vayada/domain-booking/design-colors`, VAY-2475).
 * Button text on the brand colour is always white, however light the colour (VAY-2486).
 */
export const BOOKING_DESIGN_BUTTON_FOREGROUND_COLOR = "#FFFFFF" as const;

/** Matches Booking Web's primary-600/default and primary-700/hover palette tokens. */
export function createBookingDesignButtonColors(primaryColor: string) {
  return Object.freeze({
    backgroundColor: mixWithBlack(primaryColor, 0.12),
    hoverBackgroundColor: mixWithBlack(primaryColor, 0.28),
    foregroundColor: BOOKING_DESIGN_BUTTON_FOREGROUND_COLOR,
  });
}

function mixWithBlack(hex: string, amount: number): string {
  const component = (offset: number) =>
    Math.round(Number.parseInt(hex.slice(offset, offset + 2), 16) * (1 - amount))
      .toString(16)
      .padStart(2, "0");
  return `#${component(1)}${component(3)}${component(5)}`;
}
