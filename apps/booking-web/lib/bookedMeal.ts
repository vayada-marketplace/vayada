import type { Booking } from "@/lib/types";

const PLANS = ["room_only", "breakfast", "half_board", "full_board", "all_inclusive"] as const;
export type MealPlan = (typeof PLANS)[number];
// The API's English words for a legacy booking's meal (bookedMealDescription).
const LEGACY: Record<string, MealPlan> = {
  "Room only": "room_only",
  "Breakfast included": "breakfast",
};

/** D7 (VAY-2360): a booked room's meal in plain words on the confirmation and My booking pages, "No meals
 * included" for room only. Text the page can't place (a legacy booking's own words) shows as it came. */
export function bookedMeal(
  meal: string | null | undefined,
  words: { noMeals: string; meal: (plan: Exclude<MealPlan, "room_only">) => string },
): string | null {
  const plan = meal ? (LEGACY[meal] ?? meal) : null;
  if (!plan) return null;
  if (plan === "room_only") return words.noMeals;
  return (PLANS as readonly string[]).includes(plan)
    ? words.meal(plan as Exclude<MealPlan, "room_only">)
    : plan;
}

/** The meal of a one-room booking: its booked room's plan, else the legacy text. A group has none: each
 * of its rooms says its own. */
export function singleRoomMeal(booking: Pick<Booking, "bookedRooms" | "mealDescription">) {
  if (booking.bookedRooms && booking.bookedRooms.length > 1) return null;
  return booking.bookedRooms?.[0]?.mealPlan ?? booking.mealDescription ?? null;
}
