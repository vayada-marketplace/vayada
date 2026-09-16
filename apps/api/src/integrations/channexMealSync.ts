import type { PricingMeal } from "@vayada/domain-pms";

export type ChannexMeal = {
  externalRatePlanId: string;
  externalRoomTypeId: string;
  mealType: PricingMeal["kind"];
};

export class ChannexMealSyncError extends Error {}

// Channex rate-plan metadata is separate from an OTA's meal-content contract.
export async function reconcileChannexMeals(
  propertyId: string,
  meals: ChannexMeal[],
  request: (method: "GET" | "PUT", path: string, body?: unknown) => Promise<unknown>,
): Promise<void> {
  if (!meals.length) return;
  for (const meal of meals) validateMeal(propertyId, meal);
  const mapped = new Map<string, string>();
  for (let page = 1; ; page++) {
    const response = record(
      await request(
        "GET",
        `/api/v1/channels?filter[property_id]=${encodeURIComponent(propertyId)}&pagination[limit]=100&pagination[page]=${page}`,
      ),
    );
    if (!Array.isArray(response.data))
      throw new ChannexMealSyncError("Channex channel mappings unavailable");
    for (const item of response.data) {
      const channel = record(record(item).attributes);
      if (!Array.isArray(channel.rate_plans))
        throw new ChannexMealSyncError("Channex channel rate mappings unavailable");
      for (const mapping of channel.rate_plans) {
        const id = record(mapping).rate_plan_id;
        if (typeof id !== "string")
          throw new ChannexMealSyncError("Channex channel rate mapping is invalid");
        mapped.set(id, String(channel.channel ?? channel.application ?? "OTA"));
      }
    }
    if (response.data.length < 100) break;
    if (page === 100)
      throw new ChannexMealSyncError("Channex channel mapping pagination limit exceeded");
  }
  for (const meal of meals) {
    const path = `/api/v1/rate_plans/${encodeURIComponent(meal.externalRatePlanId)}`;
    const read = () => readChannexMeal(propertyId, meal, request);
    const current = await read();
    if (current === meal.mealType) continue;
    const channel = mapped.get(meal.externalRatePlanId);
    if (channel)
      throw new ChannexMealSyncError(
        `${channel} meal synchronization is unsupported: verify meal terms on the OTA and its rate mapping. Channex meal metadata alone does not update OTA terms.`,
      );
    await request("PUT", path, { rate_plan: { meal_type: meal.mealType } });
    if ((await read()) !== meal.mealType)
      throw new ChannexMealSyncError(
        "Channex meal readback did not match the configured inclusion",
      );
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Provider metadata proof only: no publication authority, amount or OTA-display claim. */
export async function verifyChannexMealReadback(
  propertyId: string,
  meal: ChannexMeal,
  request: (method: "GET", path: string) => Promise<unknown>,
): Promise<ChannexMeal & { externalPropertyId: string }> {
  validateMeal(propertyId, meal);
  // Snapshot caller inputs before awaiting provider IO.
  const expected = {
    externalRatePlanId: meal.externalRatePlanId,
    externalRoomTypeId: meal.externalRoomTypeId,
    mealType: meal.mealType,
  };
  if ((await readChannexMeal(propertyId, expected, request)) !== expected.mealType)
    throw new ChannexMealSyncError("Channex meal readback did not match the configured inclusion");
  return { ...expected, externalPropertyId: propertyId };
}

function validateMeal(propertyId: string, meal: ChannexMeal): void {
  if (
    ![propertyId, meal?.externalRatePlanId, meal?.externalRoomTypeId].every(
      (id) => typeof id === "string" && id.trim().length > 0,
    ) ||
    !["room_only", "breakfast", "half_board", "full_board", "all_inclusive"].includes(
      meal?.mealType,
    )
  )
    throw new ChannexMealSyncError("Invalid Channex meal identity or inclusion");
}

async function readChannexMeal(
  propertyId: string,
  meal: ChannexMeal,
  request: (method: "GET", path: string) => Promise<unknown>,
): Promise<unknown> {
  const data = record(
    record(
      await request("GET", `/api/v1/rate_plans/${encodeURIComponent(meal.externalRatePlanId)}`),
    ).data,
  );
  const attributes = record(data.attributes);
  const relationships = record(data.relationships);
  const matches = (attribute: string, relationship: string, expected: string) => {
    const direct = attributes[attribute];
    const related = record(record(relationships[relationship]).data).id;
    return (
      (direct === expected || related === expected) &&
      (direct === undefined || direct === expected) &&
      (related === undefined || related === expected)
    );
  };
  if (
    data.id !== meal.externalRatePlanId ||
    !matches("property_id", "property", propertyId) ||
    !matches("room_type_id", "room_type", meal.externalRoomTypeId)
  )
    throw new ChannexMealSyncError(
      "Channex meal reconciliation property/room/rate identity mismatch",
    );
  return attributes.meal_type;
}
