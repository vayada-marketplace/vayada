/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";
import id from "@/messages/id.json";
import { NextIntlClientProvider } from "next-intl";
import type { PaymentMethodOption } from "@/lib/paymentMethodOptions";
import PaymentStep from "./PaymentStep";

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
const option = (method: PaymentMethodOption["method"], title: string): PaymentMethodOption => ({
  method,
  title,
  summary: `${title} summary`,
  explanation: `${title} explained`,
  box: [],
  button: "Confirm booking",
  busy: "Confirming booking…",
});
function render(
  options: PaymentMethodOption[],
  method: PaymentMethodOption["method"] | "" = "",
  showExplanation = true,
) {
  act(() =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale: "en",
        messages: en,
        children: createElement(PaymentStep, {
          guestName: "Ada Lovelace",
          guestEmail: "ada@example.test",
          guestPhone: "+49 30 1234567",
          onChangeDetails: () => {},
          method,
          options,
          unavailable: createElement("p", { role: "alert" }, "No way to pay fits these rooms."),
          tooSoon: null,
          onMethod: () => {},
          showExplanation,
          hasQuote: false,
          notice: null,
          acknowledgements: null,
          cancellation: [],
          confirm: null,
          onBack: () => {},
        }),
      }),
    ),
  );
  return document.body;
}

// VAY-2309: Payment offers only the ways the chosen rates take, and says so when none is left.
it("lists only the ways it is given", () => {
  const page = render([option("card", "Pay with card")], "card");
  expect(Array.from(page.querySelectorAll('[role="radio"]')).map((r) => r.textContent)).toEqual([
    "Pay with cardPay with card summaryPay with card explained",
  ]);
  expect(page.querySelector('[role="alert"]')).toBeNull();
});

// VAY-2347: the guest card, and the chosen way's full explanation once its price is current.
it("shows who books and explains only the chosen way, once priced for it", () => {
  const ways = [
    option("pay_at_property", "Pay at the hotel"),
    option("bank_transfer", "Pay by bank transfer"),
  ];
  let page = render(ways, "bank_transfer");
  expect(page.querySelector('[aria-label="Guest"]')!.textContent).toBe(
    "GuestAda Lovelaceada@example.test · +49 30 1234567Edit",
  );
  expect(page.textContent).toContain("Pay by bank transfer explained");
  expect(page.textContent).not.toContain("Pay at the hotel explained");
  page = render(ways, "bank_transfer", false);
  expect(page.textContent).not.toContain("explained");
});

it("shows why instead of an empty list when no way is left", () => {
  const page = render([], "card");
  expect(page.querySelector('[role="radiogroup"]')).toBeNull();
  expect(page.querySelector('[role="alert"]')?.textContent).toBe("No way to pay fits these rooms.");
  // Nothing about a way to pay that isn't offered.
  expect(page.textContent).not.toContain("You enter your card details in the next step.");
});

it("every locale says that no way to pay is left", () => {
  for (const messages of [de, en, es, fr, id]) {
    expect(messages.payment.noWayToPay.trim()).not.toBe("");
    expect(messages.payment.noWayToPayThisSoon.trim()).not.toBe("");
    expect(messages.payment.chooseAnotherRoom.trim()).not.toBe("");
  }
});
