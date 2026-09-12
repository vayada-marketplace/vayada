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

/** Room metadata only; not current job authority, rate-primary selection or OTA proof. */
export async function verifyChannexOfferRoom(
  room: unknown,
  identity: { externalPropertyId: string; externalRoomTypeId: string },
  request: (method: "GET", path: string) => Promise<unknown>,
) {
  const configuration = parsePricingConfiguration(room);
  if (!configuration || configuration.capacity.children !== 0)
    throw new ChannexMealSyncError("Channex adult room configuration unavailable");
  const expected = {
    externalPropertyId: identity?.externalPropertyId,
    externalRoomTypeId: identity?.externalRoomTypeId,
    adults: configuration.capacity.adults,
  };
  if (
    ![expected.externalPropertyId, expected.externalRoomTypeId].every(
      (id) => typeof id === "string" && id.length > 0 && id === id.trim(),
    )
  )
    throw new ChannexMealSyncError("Invalid Channex room identity");
  const response = structuredClone(
    await request("GET", `/api/v1/room_types/${encodeURIComponent(expected.externalRoomTypeId)}`),
  );
  const data = record(record(response).data);
  const attributes = record(data.attributes);
  const propertyRelationship = record(data.relationships).property;
  const relatedProperty = record(record(propertyRelationship).data).id;
  if (
    data.type !== "room_type" ||
    data.id !== expected.externalRoomTypeId ||
    (attributes.id !== undefined && attributes.id !== expected.externalRoomTypeId) ||
    (attributes.property_id !== expected.externalPropertyId &&
      relatedProperty !== expected.externalPropertyId) ||
    (attributes.property_id !== undefined &&
      attributes.property_id !== expected.externalPropertyId) ||
    (propertyRelationship !== undefined && relatedProperty !== expected.externalPropertyId) ||
    attributes.room_kind !== "room" ||
    attributes.capacity !== null ||
    attributes.occ_adults !== expected.adults ||
    attributes.occ_children !== 0 ||
    attributes.occ_infants !== 0
  )
    throw new ChannexMealSyncError("Channex room identity or adult capacity mismatch");
  return { ...expected, children: 0 as const, infants: 0 as const, roomKind: "room" as const };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
