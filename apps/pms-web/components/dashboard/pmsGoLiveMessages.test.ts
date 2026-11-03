import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GO_LIVE_CHECKLIST_MESSAGES,
  type GoLiveChecklistMessages,
} from "@vayada/product-onboarding/GoLiveChecklistCard";
import { describe, expect, it } from "vitest";

import { SUPPORTED_LANGUAGES } from "@/lib/i18n/languages";
import { pmsGoLiveMessages } from "./pmsGoLiveMessages";

const MESSAGES = resolve(dirname(fileURLToPath(import.meta.url)), "../../messages");

function catalog(code: string): Record<string, string> {
  return JSON.parse(readFileSync(resolve(MESSAGES, `${code}.json`), "utf8"));
}

function translate(code: string) {
  const words = catalog(code);
  return (key: string, params: Record<string, string | number> = {}) =>
    Object.entries(params).reduce(
      (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
      words[key] ?? key,
    );
}

const KEYS = Object.keys(catalog("en")).filter((key) => key.startsWith("dashboard.goLive."));

/** What the cards' functions say, with sample names and counts (one and many). */
function filledIn(messages: GoLiveChecklistMessages) {
  return {
    setupTitle: messages.setupTitle("Lumansa"),
    setupNext: [1, 5].map((minutes) => messages.setupNext("First room", minutes)),
    stepNext: [1, 5].map((minutes) => messages.stepNext(minutes)),
    stepTime: [1, 5].map((minutes) => messages.stepTime(minutes)),
    doneCount: messages.doneCount(2, 6),
    roomTypesDone: [
      { name: "Pool Villa", rooms: 2, maxGuests: 4, photos: 1 },
      { name: "Garden Room", rooms: 1, maxGuests: 2, photos: 3 },
    ].map((room) => messages.roomTypesDone(room)),
  };
}

/** Every text the cards can show. */
function everyText(messages: GoLiveChecklistMessages): string[] {
  const texts: string[] = [messages.setupTitle("")];
  const walk = (value: unknown) => {
    if (typeof value === "string") texts.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(JSON.parse(JSON.stringify(messages)));
  walk(filledIn(messages));
  return texts;
}

describe("PMS go-live card words (VAY-2451)", () => {
  it("says in English exactly what the cards say by default", () => {
    const en = pmsGoLiveMessages(translate("en"));
    // JSON drops the functions: every fixed text and the steps' minutes.
    expect(JSON.parse(JSON.stringify(en))).toEqual(
      JSON.parse(JSON.stringify(GO_LIVE_CHECKLIST_MESSAGES)),
    );
    expect(filledIn(en)).toEqual(filledIn(GO_LIVE_CHECKLIST_MESSAGES));
    expect(en.setupTitle("Lumansa")).toBe("Finish setting up Lumansa");
    expect(en.doneCount(2, 6)).toBe("2 of 6 done");
    expect(en.roomTypesDone({ name: "Pool Villa", rooms: 2, maxGuests: 4, photos: 1 })).toBe(
      "Pool Villa · 2 rooms · up to 4 guests · 1 photo",
    );
    expect(en.toast).toBe("Setup complete. A few steps left before you go live.");
  });

  it("names the property generically before its name is known", () => {
    expect(pmsGoLiveMessages(translate("en")).setupTitle(" ")).toBe(
      "Finish setting up your property",
    );
    expect(pmsGoLiveMessages(translate("de")).setupTitle("")).toBe(
      "Ihre Unterkunft fertig einrichten",
    );
  });

  it("asks for every dashboard.goLive key, and only those", () => {
    const asked = new Set<string>();
    const t = translate("en");
    everyText(
      pmsGoLiveMessages((key, params) => {
        asked.add(key);
        return t(key, params);
      }),
    );
    expect(Array.from(asked).sort()).toEqual([...KEYS].sort());
  });

  for (const { code } of SUPPORTED_LANGUAGES) {
    it(`${code} has every go-live text, with nothing left to fill in`, () => {
      const words = catalog(code);
      expect(KEYS.filter((key) => !words[key])).toEqual([]);
      for (const text of everyText(pmsGoLiveMessages(translate(code)))) {
        expect(text).not.toContain("dashboard.goLive.");
        expect(text).not.toMatch(/\{\w+\}/);
      }
    });
  }

  it("counts rooms and photos in German too", () => {
    const de = pmsGoLiveMessages(translate("de"));
    expect(de.roomTypesDone({ name: "Pool Villa", rooms: 2, maxGuests: 4, photos: 1 })).toBe(
      "Pool Villa · 2 Zimmer · bis zu 4 Gäste · 1 Foto",
    );
    expect(de.setupNext("Erstes Zimmer", 5)).toContain("etwa 5 Minuten");
  });
});
