import { expect, it } from "vitest";
import { bookedMeal, singleRoomMeal } from "./bookedMeal";
import { directPerks } from "./directPerks";

const words = { noMeals: "No meals included", meal: (plan: string) => `meal:${plan}` };

it("names a booked meal in plain words (VAY-2360 D7)", () => {
  expect(bookedMeal("room_only", words)).toBe("No meals included");
  expect(bookedMeal("breakfast", words)).toBe("meal:breakfast");
  // A legacy booking's English words are read back as their plan.
  expect(bookedMeal("Room only", words)).toBe("No meals included");
  expect(bookedMeal("Breakfast included", words)).toBe("meal:breakfast");
  expect(bookedMeal("Suite: Half board; Villa: Room only", words)).toBe(
    "Suite: Half board; Villa: Room only",
  );
  expect(bookedMeal(null, words)).toBeNull();
});

it("takes a one-room booking's meal from its booked room, and none for a group", () => {
  const room = { roomTypeId: "r", roomName: "Suite", adults: 2, children: 0, cancellation: null };
  expect(
    singleRoomMeal({
      bookedRooms: [{ ...room, mealPlan: "room_only" }],
      mealDescription: "Room only",
    }),
  ).toBe("room_only");
  expect(singleRoomMeal({ mealDescription: "Breakfast included" })).toBe("Breakfast included");
  expect(
    singleRoomMeal({
      bookedRooms: [
        { ...room, mealPlan: "room_only" },
        { ...room, mealPlan: "breakfast" },
      ],
    }),
  ).toBeNull();
});

it("translates Book Direct Benefits presets and keeps the hotel's own words (VAY-2360 D1)", () => {
  const translate = (key: string) => `perk:${key}`;
  expect(
    directPerks(["Welcome Drink on Arrival", "  Sunset yoga  ", "10% Spa Discount"], translate),
  ).toEqual(["perk:welcomeDrink", "Sunset yoga"]);
  expect(directPerks(["", 3, "Free Airport Transfer"], translate)).toEqual([
    "perk:airportTransfer",
  ]);
  expect(directPerks(undefined, translate)).toEqual([]);
});
