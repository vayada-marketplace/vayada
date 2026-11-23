import { describe, expect, it } from "vitest";
import {
  allowanceDates,
  assistantEnglish,
  assistantGerman,
  assistantMessagesFor,
  fill,
} from "./assistantMessages";

const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe("assistant messages", () => {
  it("has German for every English text, with the same placeholders", () => {
    expect(Object.keys(assistantGerman).sort()).toEqual(Object.keys(assistantEnglish).sort());
    for (const key of Object.keys(assistantEnglish) as (keyof typeof assistantEnglish)[]) {
      const english = assistantEnglish[key];
      const german = assistantGerman[key];
      if (typeof english === "string") expect(placeholders(german as string), key).toEqual(placeholders(english));
    }
    expect(Object.keys(assistantGerman.tools).sort()).toEqual(Object.keys(assistantEnglish.tools).sort());
  });

  it("names every tool the assistant has today (properties, rooms, calendar)", () => {
    expect(Object.keys(assistantEnglish.tools).sort()).toEqual([
      "calendar_days",
      "properties_list",
      "rooms_list",
    ]);
  });

  it("shows German for German and English for every other language", () => {
    expect(assistantMessagesFor("de")).toBe(assistantGerman);
    expect(assistantMessagesFor("de-AT")).toBe(assistantGerman);
    expect(assistantMessagesFor("en")).toBe(assistantEnglish);
    expect(assistantMessagesFor("fr")).toBe(assistantEnglish);
  });

  it("fills placeholders and leaves unknown ones as they are", () => {
    expect(fill("Hi {name}, {missing}", { name: "Alex" })).toBe("Hi Alex, {missing}");
  });

  it("names the used-up month and the day the next allowance starts", () => {
    const december = new Date(2026, 11, 14, 10);
    expect(allowanceDates("en", december)).toEqual({ month: "December", resetDate: "1 January" });
    expect(allowanceDates("de", december)).toEqual({ month: "Dezember", resetDate: "1. Januar" });
    expect(fill(assistantEnglish.allowancePlaceholder, allowanceDates("en", december))).toBe(
      "Paused until vayada raises it or 1 January",
    );
  });
});
