import { createTranslator } from "next-intl";
import { expect, it } from "vitest";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";
import id from "@/messages/id.json";
import { paymentMethodOptions } from "./paymentMethodOptions";

/** The page's `reviewPay` messages as the plain function the builder takes. */
function translator(locale: string, messages: unknown) {
  const tr = createTranslator({ locale, messages: messages as typeof en, namespace: "reviewPay" });
  return (key: string, values?: Record<string, string>) => tr(key as never, values as never);
}
const t = translator("en", en);
const full = { total: "€240", now: "€0", later: "€240", zero: "€0" };

it("words each way to pay, its payment lines and its button (VAY-2347)", () => {
  const [hotel, bank, paypal] = paymentMethodOptions(
    ["pay_at_property", "bank_transfer", "paypal"],
    { request: false, amounts: full },
    t,
  );
  expect(hotel).toEqual({
    method: "pay_at_property",
    title: "Pay at the hotel",
    summary: "Nothing to pay now · you pay when you arrive",
    explanation:
      "You pay €240 at the hotel when you arrive. Your booking is confirmed straight away.",
    box: [
      { label: "Pay now", value: "€0" },
      { label: "At the hotel", value: "€240" },
    ],
    button: "Confirm booking",
    busy: "Confirming booking…",
  });
  expect(bank!.title).toBe("Pay by bank transfer");
  expect(bank!.box).toEqual([
    { label: "Pay now", value: "€0" },
    { label: "By bank transfer", value: "€240" },
  ]);
  expect(paypal!.button).toBe("Confirm booking");
});

it("says nothing is charged until a request is accepted; bank transfer still waits for the money", () => {
  const [hotel, bank] = paymentMethodOptions(
    ["pay_at_property", "bank_transfer"],
    { request: true, amounts: full },
    t,
  );
  expect(hotel!.explanation).toBe(
    "Nothing is charged now. If the hotel accepts your request, you pay €240 when you arrive. The hotel answers within 24 hours.",
  );
  expect(hotel!.button).toBe("Send booking request");
  expect(hotel!.busy).toBe("Sending request…");
  expect(bank!.button).toBe("Confirm booking");
  expect(bank!.explanation).toContain("once your transfer arrives");
});

it("words card payments, holds and a part paid at the hotel", () => {
  const card = (request: boolean, later: string) =>
    paymentMethodOptions(
      ["card"],
      {
        request,
        amounts: { total: "€240", now: later === "€0" ? "€240" : "€72", later, zero: "€0" },
      },
      t,
    )[0]!;
  expect(card(false, "€0")).toMatchObject({
    summary: "Charged when you book",
    box: [{ label: "Charged now", value: "€240" }],
    button: "Continue to card details",
  });
  expect(card(false, "€168").explanation).toBe(
    "We charge €72 to your card when you confirm, and you pay the rest, €168, at the hotel. You enter your card details in the next step.",
  );
  expect(card(false, "€168").box).toEqual([
    { label: "Charged now", value: "€72" },
    { label: "At the hotel", value: "€168" },
  ]);
  expect(card(true, "€0")).toMatchObject({
    summary: "Charged only when the hotel accepts",
    box: [
      { label: "Card hold now", value: "€240" },
      { label: "Charged", value: "When the hotel accepts" },
    ],
  });
});

it("has every way to pay's words in all five languages", () => {
  for (const [locale, messages] of Object.entries({ en, de, fr, es, id })) {
    const tr = translator(locale, messages);
    for (const request of [false, true]) {
      for (const option of paymentMethodOptions(
        ["pay_at_property", "card", "bank_transfer", "paypal"],
        { request, amounts: { total: "1", now: "2", later: "3", zero: "0" } },
        tr,
      )) {
        for (const text of [option.title, option.summary, option.explanation, option.button])
          expect(text, `${locale} ${option.method}`).not.toMatch(/reviewPay\.|^$/);
      }
    }
  }
});
