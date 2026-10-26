/** The presets of Booking Admin's Book Direct Benefits (VAY-2072), stored as their English text, with their
 * `confirmation.perk` messages. */
const PRESETS = {
  "Welcome Drink on Arrival": "welcomeDrink",
  "10% Spa Discount": "spaDiscount",
  "Late Check-out (subject to availability)": "lateCheckOut",
  "Early Check-in (subject to availability)": "earlyCheckIn",
  "Free Airport Transfer": "airportTransfer",
  "Daily Breakfast Included": "breakfast",
  "Room Upgrade (subject to availability)": "upgrade",
} as const;
export type PerkKey = (typeof PRESETS)[keyof typeof PRESETS];

/** VAY-2360: the hotel's direct-booking perks for the confirmation page, first `limit` of them, in the hotel's
 * order: a preset in the guest's language, the hotel's own line as written. */
export function directPerks(
  benefits: unknown,
  translate: (key: PerkKey) => string,
  limit = 2,
): string[] {
  if (!Array.isArray(benefits)) return [];
  return benefits
    .filter((benefit): benefit is string => typeof benefit === "string" && !!benefit.trim())
    .slice(0, limit)
    .map((benefit) =>
      benefit in PRESETS ? translate(PRESETS[benefit as keyof typeof PRESETS]) : benefit.trim(),
    );
}
