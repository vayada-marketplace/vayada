import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HotelSetupChecklistMessages } from "@vayada/product-onboarding/hotelSetupChecklistMessages";
import { describe, expect, it } from "vitest";

import { SUPPORTED_LANGUAGES } from "@/lib/i18n/languages";
import { bookingAdminChecklistMessages } from "./bookingAdminChecklistMessages";

function translate(code: string) {
  const catalog = JSON.parse(
    readFileSync(resolve(import.meta.dirname, `../../messages/${code}.json`), "utf8"),
  ) as Record<string, string>;
  return (key: string, params: Record<string, string | number> = {}) =>
    Object.entries(params).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      catalog[key] ?? key,
    );
}

/** Every text the card can show, with sample counts and names filled in. */
function everyText(messages: HotelSetupChecklistMessages): string[] {
  const texts: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string") texts.push(value);
    else if (typeof value === "function") texts.push(String(value(4, 9)));
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk({ ...messages, items: undefined, liveTitle: undefined });
  texts.push(messages.liveTitle("Hotel Alpenrose"), messages.liveTitle(""));
  for (const item of Object.values(messages.items)) {
    texts.push(item.name, item.title);
    for (const roomCount of [null, 1, 8]) texts.push(item.description({ roomCount }));
  }
  return texts;
}

describe("Booking Admin setup checklist words (VAY-2247 wave 2)", () => {
  for (const { code } of SUPPORTED_LANGUAGES) {
    it(`${code} has every text, with nothing left to fill in`, () => {
      for (const text of everyText(bookingAdminChecklistMessages(translate(code)))) {
        expect(text).not.toContain("dashboard.checklist.");
        expect(text).not.toMatch(/\{\w+\}/);
      }
    });
  }

  it("says Booking Admin's own line under the title, in German too", () => {
    expect(bookingAdminChecklistMessages(translate("en")).liveSubtitle.booking_admin).toBe(
      "Same checklist in the PMS and Booking Admin. Progress is shared.",
    );
    const de = bookingAdminChecklistMessages(translate("de"));
    expect(de.liveTitle("Hotel Alpenrose")).toBe("Hotel Alpenrose fertig einrichten");
    expect(de.items.style.description({ roomCount: null })).toContain(
      "öffnet Booking Admin → Designstudio",
    );
  });

  it("names the hotel generically without a name, and counts one room", () => {
    const en = bookingAdminChecklistMessages(translate("en"));
    expect(en.liveTitle(" ")).toBe("Finish setting up your hotel");
    expect(en.items.calendar.description({ roomCount: 1 })).toContain("1 room bookable");
    const es = bookingAdminChecklistMessages(translate("es"));
    expect(es.items.calendar.description({ roomCount: 1 })).toContain("1 habitación reservable");
    expect(es.items.calendar.description({ roomCount: 8 })).toContain(
      "las 8 habitaciones reservables",
    );
  });
});
