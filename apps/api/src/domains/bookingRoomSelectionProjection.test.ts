import { describe, expect, it } from "vitest";
import { bookedMealDescription } from "./bookingRoomSelectionProjection.js";

describe("purchased meal evidence", () => {
  it("uses frozen purchased terms regardless of subsequent plan edits and leaves unknown history unknown", () => {
    const currentPlan = { mealPlan: "breakfast" };
    const purchased = JSON.parse(JSON.stringify({ rateSummary: currentPlan }));
    currentPlan.mealPlan = "room_only";
    expect(bookedMealDescription(purchased)).toBe("Breakfast included");
    expect(bookedMealDescription({ rateSummary: currentPlan })).toBe("Room only");
    expect(bookedMealDescription({})).toBeNull();
    expect(bookedMealDescription({ rateSummary: { mealPlan: null } })).toBeNull();
    expect(
      bookedMealDescription({
        roomLines: [
          { offer: { roomSummary: { name: "Suite" }, ...purchased } },
          { offer: { roomSummary: { name: "Studio" }, rateSummary: currentPlan } },
        ],
      }),
    ).toBe("Suite: Breakfast included; Studio: Room only");
  });
});
