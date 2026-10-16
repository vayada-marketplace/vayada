import { BRAND_FONT_PAIRINGS } from "@vayada/fonts/brand";
import { BOOKING_PAGE_FONT_PAIRINGS } from "@vayada/product-onboarding";

export { BOOKING_PAGE_COLOR_PRESETS as COLOR_PRESETS } from "@vayada/product-onboarding";

// Rendered with the self-hosted files the guest booking site uses, so the Design Studio shows
// exactly what guests see and never contacts Google (VAY-2225).
export const FONT_PAIRINGS = BOOKING_PAGE_FONT_PAIRINGS.map((pairing) => ({
  ...pairing,
  headingFamily: BRAND_FONT_PAIRINGS[pairing.id].heading,
  bodyFamily: BRAND_FONT_PAIRINGS[pairing.id].body,
}));
