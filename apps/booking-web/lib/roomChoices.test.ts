import { describe, expect, it } from "vitest";
import messages from "../messages/en.json";
import { choiceKeys, choiceText, freeCancellationUntil, hotelToday } from "./roomChoices";
import type { PricingOffer } from "@/services/api/replacementOffers";

const choice = messages.home.choice as unknown as Record<string, unknown>;
const t = (key: string, values: Record<string, string | number> = {}) => {
  const text = key
    .split(".")
    .slice(1)
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], choice) as string;
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
};
const offer = (
  mealPlan: PricingOffer["mealPlan"],
  cancellation?: PricingOffer["cancellation"],
): PricingOffer => ({ publicOfferKey: "key", currency: "EUR", mealPlan, cancellation });
const free = (days: number) => ({ kind: "free_until_days_before_arrival" as const, days });
const stay = {
  checkIn: "2026-11-06",
  timezone: "Europe/Berlin",
  formatDate: (date: string) => date,
};
const now = new Date("2026-10-14T08:00:00Z");
const text = (offers: PricingOffer[]) =>
  choiceKeys(offers).map((keys) => {
    const { name, terms } = choiceText(keys, stay, t, now);
    return `${name} | ${terms}`;
  });

describe("room choices", () => {
  it("names choices plainly, with their terms for the stay", () => {
    expect(
      text([
        offer("room_only", free(3)),
        offer("room_only", { kind: "non_refundable" }),
        offer("breakfast", free(3)),
        offer("breakfast", { kind: "non_refundable" }),
        offer("half_board", { kind: "partial_refund" }),
        offer("room_only"),
      ]),
    ).toEqual([
      "Free cancellation | Free cancellation until 2026-11-03",
      "Non-refundable | No refund if you cancel or don't arrive",
      "Breakfast included | Breakfast every morning · Free cancellation until 2026-11-03",
      "Breakfast included, non-refundable | Breakfast every morning · No refund if you cancel or don't arrive",
      "Half board, partial refund | Breakfast and dinner every day · Part of the price is refunded if you cancel. See our terms on the next step",
      "Room only | ",
    ]);
  });

  it("uses the hotel's own meal text in place of the fixed one (VAY-2281)", () => {
    expect(
      text([
        { ...offer("breakfast", free(3)), mealDescription: "Buffet breakfast, 7:00–10:30" },
        offer("breakfast", { kind: "non_refundable" }),
      ]),
    ).toEqual([
      "Breakfast included | Buffet breakfast, 7:00–10:30 · Free cancellation until 2026-11-03",
      "Breakfast included, non-refundable | Breakfast every morning · No refund if you cancel or don't arrive",
    ]);
  });

  it("numbers choices that would read the same in one room", () => {
    expect(
      text([
        offer("room_only", free(3)),
        offer("room_only", free(7)),
        offer("room_only", free(1)),
      ]).map((line) => line.split(" | ")[0]),
    ).toEqual(["Free cancellation", "Free cancellation 2", "Free cancellation 3"]);
  });

  it("drops free cancellation once its last day has passed in the hotel's time zone", () => {
    const keys = choiceKeys([offer("breakfast", free(3))])[0]!;
    // The last free day itself still counts, as on the old booking page.
    expect(choiceText(keys, { ...stay, checkIn: "2026-10-17" }, t, now)).toMatchObject({
      name: "Breakfast included",
      cancellationPassed: false,
    });
    expect(choiceText(keys, { ...stay, checkIn: "2026-10-16" }, t, now)).toEqual({
      name: "Breakfast included",
      terms: "Breakfast every morning · Free cancellation is no longer available for these dates",
      meal: "Breakfast included",
      cancellationTerms: "Free cancellation is no longer available for these dates",
      refundable: null,
      cancellationPassed: true,
    });
    expect(
      choiceText(
        choiceKeys([offer("room_only", free(3))])[0]!,
        { ...stay, checkIn: "2026-10-16" },
        t,
        now,
      ).name,
    ).toBe("Room only");
  });

  it("names a choice before the stay's dates are known", () => {
    const keys = choiceKeys([offer("room_only", free(3))])[0]!;
    expect(choiceText(keys, { ...stay, checkIn: "" }, t, now)).toEqual({
      name: "Free cancellation",
      terms: "",
      meal: null,
      cancellationTerms: null,
      refundable: true,
      cancellationPassed: false,
    });
  });

  it("gives a booked room's meal and cancellation on their own (VAY-2320)", () => {
    const [roomOnly, breakfast] = choiceKeys([
      offer("room_only", free(3)),
      offer("breakfast", free(3)),
    ]);
    expect(choiceText(roomOnly!, stay, t, now)).toMatchObject({
      meal: null,
      cancellationTerms: expect.stringMatching(/^Free cancellation until /),
    });
    expect(choiceText(breakfast!, stay, t, now)).toMatchObject({
      meal: "Breakfast included",
      cancellationTerms: expect.stringMatching(/^Free cancellation until /),
    });
  });

  it("counts deadlines in calendar days and the hotel's today", () => {
    expect(freeCancellationUntil("2026-03-02", 3)).toBe("2026-02-27");
    expect(hotelToday("Pacific/Auckland", new Date("2026-10-14T12:30:00Z"))).toBe("2026-10-15");
    expect(hotelToday("America/Los_Angeles", new Date("2026-10-14T05:00:00Z"))).toBe("2026-10-13");
  });
});
