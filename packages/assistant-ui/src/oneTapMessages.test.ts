import { describe, expect, it } from "vitest";
import { assistantMessagesFor } from "./assistantMessages";
import { oneTapMessagesFor } from "./oneTapMessages";

/** The card's words that speak of the chat in the app, and of the AI app here. */
const OWN = ["footnote", "doneBody", "expiredBody", "changedBody", "stoppedBody"];
const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe("the one-tap page's words (VAY-2528)", () => {
  it.each(["en", "de"])(
    "keep the in-app card's words except where they speak of the chat (%s)",
    (locale) => {
      const page = oneTapMessagesFor(locale);
      const inApp = assistantMessagesFor(locale).change;
      expect(Object.keys(page.change).sort()).toEqual(Object.keys(inApp).sort());
      for (const [key, text] of Object.entries(page.change)) {
        const own = inApp[key as keyof typeof inApp];
        // Asked from an AI app, answered here: never "the chat", never "ask me".
        expect(text, key).not.toMatch(/chat|ask me|fragen sie mich/i);
        if (OWN.includes(key)) expect(text, key).not.toBe(own);
        else expect(text, key).toBe(own);
        expect(placeholders(text), key).toEqual(placeholders(own));
      }
      for (const text of [page.title, page.intro, page.otherHotel]) {
        expect(text.length).toBeGreaterThan(10);
      }
    },
  );

  it("is German for German, and English for every other language", () => {
    expect(oneTapMessagesFor("de-AT").title).toBe("Ihre KI-App möchte etwas ändern");
    expect(oneTapMessagesFor("fr").title).toBe("Your AI app asked for a change");
    expect(oneTapMessagesFor("de").change.no).toBe("Nein");
  });
});
