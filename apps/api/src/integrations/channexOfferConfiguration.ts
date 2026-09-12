import { parsePricingConfiguration } from "@vayada/domain-pms";

/** Closed configuration fragment, not an HTTP request or a capability/send permit.
 * Daily prices and restrictions must be verified separately before opening sales.
 */
export function planChannexOfferConfiguration(
  room: unknown,
  offerId: string,
  primaryOccupancy: number,
) {
  const unavailable = (reason: string) => ({ kind: "unavailable" as const, reason });
  const configuration = parsePricingConfiguration(room);
  if (!configuration) return unavailable("invalid_configuration");
  const offer = configuration.offers.find((offer) => offer.id === offerId);
  if (!offer) return unavailable("selection_unavailable");
  const capacity = configuration.capacity.adults;
  if (
    !Number.isSafeInteger(primaryOccupancy) ||
    primaryOccupancy < 1 ||
    primaryOccupancy > capacity
  )
    return unavailable("invalid_primary_occupancy");
  if (configuration.capacity.children > 0) return unavailable("child_representation_unavailable");
  // Same local work ceiling as the nightly candidate adapter, not provider capability.
  if (capacity > 100) return unavailable("candidate_limit");
  return {
    kind: "planned" as const,
    configuration: {
      sell_mode: "per_person" as const,
      rate_mode: "manual" as const,
      parent_rate_plan_id: null,
      inherit_rate: false,
      currency: configuration.currency,
      meal_type: offer.meal.kind,
      options: Array.from({ length: capacity }, (_, index) => ({
        occupancy: index + 1,
        is_primary: index + 1 === primaryOccupancy,
      })),
      stop_sell: Array<boolean>(7).fill(true),
    },
  };
}
