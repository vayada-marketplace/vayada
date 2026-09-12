import { parsePricingConfiguration } from "@vayada/domain-pms";
import { ChannexMealSyncError, verifyChannexMealReadback } from "./channexMealSync.js";

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

/** Metadata observation only: default closure is not daily ARI or activation proof. */
export async function verifyChannexOfferConfiguration(
  room: unknown,
  offerId: string,
  primaryOccupancy: number,
  identity: { externalPropertyId: string; externalRoomTypeId: string; externalRatePlanId: string },
  request: (method: "GET", path: string) => Promise<unknown>,
) {
  const plan = planChannexOfferConfiguration(room, offerId, primaryOccupancy);
  if (plan.kind !== "planned") throw new ChannexMealSyncError(plan.reason);
  const expected = plan.configuration;
  const scope = { ...identity };
  const observed = await verifyChannexMealReadback(
    scope.externalPropertyId,
    { ...scope, mealType: expected.meal_type },
    async (method, path) => {
      const response = structuredClone(await request(method, path));
      const data = record(record(response).data);
      const attributes = record(data.attributes);
      const parent = record(record(data.relationships).parent_rate_plan).data;
      const options = attributes.options;
      const mismatch = () => {
        throw new ChannexMealSyncError("Channex offer configuration readback mismatch");
      };
      if (
        attributes.sell_mode !== expected.sell_mode ||
        attributes.rate_mode !== expected.rate_mode ||
        attributes.currency !== expected.currency ||
        attributes.inherit_rate !== false ||
        attributes.inherit_stop_sell !== false ||
        attributes.auto_rate_settings !== null ||
        (attributes.parent_rate_plan_id !== null && parent !== null) ||
        (attributes.parent_rate_plan_id !== undefined && attributes.parent_rate_plan_id !== null) ||
        (parent !== undefined && parent !== null) ||
        (attributes.id !== undefined && attributes.id !== scope.externalRatePlanId) ||
        !Array.isArray(attributes.stop_sell) ||
        attributes.stop_sell.length !== 7 ||
        !Array.from(attributes.stop_sell).every((closed) => closed === true) ||
        !Array.isArray(options) ||
        options.length !== expected.options.length
      )
        mismatch();
      // Compare by occupancy: provider ordering and unrelated option metadata may differ.
      const remaining = new Map(
        expected.options.map((option) => [option.occupancy, option.is_primary]),
      );
      for (const raw of options as unknown[]) {
        const option = record(raw);
        const occupancy = option.occupancy as number;
        if (
          !remaining.has(occupancy) ||
          option.is_primary !== remaining.get(occupancy) ||
          option.derived_option !== null
        )
          mismatch();
        remaining.delete(occupancy);
      }
      return response;
    },
  );
  return { ...observed, configuration: expected };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
