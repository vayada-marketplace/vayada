import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import { freeCancellationUntil } from "@vayada/domain-booking/replacement-pricing";
import de from "../messages/de.json";
import en from "../messages/en.json";
import es from "../messages/es.json";
import fr from "../messages/fr.json";
import id from "../messages/id.json";
import { choiceKeys, choiceText, hotelToday } from "./roomChoices";
import type { PricingOffer } from "@/services/api/replacementOffers";

function translator(locale: string, messages: unknown) {
  const tr = createTranslator({ locale, messages: messages as typeof en, namespace: "home" });
  return (key: string, values?: Record<string, string | number>) =>
    tr(key as never, values as never);
}
const t = translator("en", en);
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
      "Free cancellation | Free cancellation until 2026-11-03, 23:59 (local time)",
      "Non-refundable | No refund if you cancel or don't arrive",
      "Breakfast included | Breakfast every morning · Free cancellation until 2026-11-03, 23:59 (local time)",
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
      "Breakfast included | Buffet breakfast, 7:00–10:30 · Free cancellation until 2026-11-03, 23:59 (local time)",
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

  it("names free cancellation non-refundable once its last day has passed in the hotel's time zone (VAY-2392)", () => {
    const keys = choiceKeys([offer("breakfast", free(3))])[0]!;
    // The last free day itself still counts, as on the old booking page.
    expect(choiceText(keys, { ...stay, checkIn: "2026-10-17" }, t, now)).toMatchObject({
      name: "Breakfast included",
      refundable: true,
      cancellationPassed: false,
    });
    const passed =
      "Free cancellation ends 3 days before arrival. For these dates, no refund if you cancel or don't arrive";
    expect(choiceText(keys, { ...stay, checkIn: "2026-10-16" }, t, now)).toEqual({
      name: "Breakfast included, non-refundable",
      terms: `Breakfast every morning · ${passed}`,
      meal: "Breakfast included",
      cancellationTerms: passed,
      refundable: false,
      cancellationPassed: true,
    });
    // Never the meal as the name: a room-only rate reads "Non-refundable", whatever the language.
    const roomOnly = (days: number) => choiceKeys([offer("room_only", free(days))])[0]!;
    expect(choiceText(roomOnly(3), { ...stay, checkIn: "2026-10-16" }, t, now)).toMatchObject({
      name: "Non-refundable",
      terms: passed,
    });
    expect(choiceText(roomOnly(1), { ...stay, checkIn: "2026-10-14" }, t, now).terms).toBe(
      "Free cancellation ends 1 day before arrival. For these dates, no refund if you cancel or don't arrive",
    );
    for (const [locale, messages] of Object.entries({ de, es, fr, id })) {
      const tl = translator(locale, messages);
      const text = choiceText(roomOnly(3), { ...stay, checkIn: "2026-10-16" }, tl, now);
      expect(text.name, locale).toBe(tl("choice.nonRefundable"));
      expect(text.terms, locale).toMatch(/3/);
      expect(text.terms, locale).not.toMatch(/[{}#]/);
    }
  });

  it("numbers a passed free cancellation after the room's own non-refundable choice (VAY-2392)", () => {
    const inside = { ...stay, checkIn: "2026-10-16" };
    const names = (offers: PricingOffer[], forStay?: typeof stay) =>
      choiceKeys(offers, forStay, now).map(
        (keys) => choiceText(keys, forStay ?? stay, t, now).name,
      );
    expect(
      names([offer("room_only", free(3)), offer("room_only", { kind: "non_refundable" })], inside),
    ).toEqual(["Non-refundable 2", "Non-refundable"]);
    // A free cancellation that is still open keeps the plain name once the other has passed.
    expect(names([offer("room_only", free(7)), offer("room_only", free(1))], inside)).toEqual([
      "Non-refundable",
      "Free cancellation",
    ]);
    // Without the stay, the names are numbered as before.
    expect(names([offer("room_only", free(7)), offer("room_only", free(1))])).toEqual([
      "Free cancellation",
      "Free cancellation 2",
    ]);
  });

  it("judges the deadline on the hotel's calendar, not UTC's (VAY-2392)", () => {
    // Free until the 15th; 20:00 UTC on the 15th is already the 16th in Colombo.
    const keys = choiceKeys([offer("room_only", free(3))])[0]!;
    const at = new Date("2026-10-15T20:00:00Z");
    const passed = (timezone: string) =>
      choiceText(keys, { ...stay, checkIn: "2026-10-18", timezone }, t, at).cancellationPassed;
    expect(passed("Asia/Colombo")).toBe(true);
    expect(passed("Etc/UTC")).toBe(false);
    expect(passed("America/Los_Angeles")).toBe(false);
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
