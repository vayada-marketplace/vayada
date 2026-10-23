/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import fr from "@/messages/fr.json";
import id from "@/messages/id.json";
import type { PricingPaymentMethod } from "@vayada/domain-booking/replacement-pricing";
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
function render(available: PricingPaymentMethod[], method: PricingPaymentMethod | "" = "") {
  act(() =>
    root.render(
      createElement(PaymentStep, {
        guestName: "Ada Lovelace",
        guestEmail: "ada@example.test",
        onChangeDetails: () => {},
        method,
        available,
        unavailable: createElement("p", { role: "alert" }, "No way to pay fits these rooms."),
        tooSoon: null,
        onMethod: () => {},
        quote: undefined,
        total: "",
        notice: null,
        acknowledgements: null,
        cancellation: [],
        confirm: null,
        onBack: () => {},
      }),
    ),
  );
  return document.body;
}

// VAY-2309: Payment offers only the ways the chosen rates take, and says so when none is left.
it("lists only the ways it is given", () => {
  const page = render(["card"], "card");
  expect(Array.from(page.querySelectorAll('[role="radio"]')).map((r) => r.textContent)).toEqual([
    expect.stringContaining("Pay by card now"),
  ]);
  expect(page.querySelector('[role="alert"]')).toBeNull();
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
