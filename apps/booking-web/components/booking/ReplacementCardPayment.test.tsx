/** @vitest-environment jsdom */
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PricingCardPaymentRequired } from "@/services/api/pricingAcceptance";
import ReplacementCardPayment from "./ReplacementCardPayment";

vi.mock("@/components/StripeProvider", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@stripe/react-stripe-js", () => ({
  PaymentElement: () => null,
  useStripe: () => null,
  useElements: () => null,
}));

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("holds the rooms until a 24-hour time and speaks as the hotel for a request", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const required = {
    bookingReference: "VAY-1268",
    payment: {
      clientSecret: "pi_secret",
      stripeAccountId: "acct_test",
      expiresAt: "2026-10-14T20:15:00.000Z",
    },
  } as unknown as PricingCardPaymentRequired;
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(ReplacementCardPayment, {
        slug: "hotel-alpenrose",
        quoteId: "q",
        required,
        request: true,
        onPaid: () => undefined,
      }),
    ),
  );
  expect(host.textContent).toMatch(/Your rooms are held until \d{2}:\d{2}\. Booking reference/);
  expect(host.textContent).not.toMatch(/\b(AM|PM|am|pm)\b/);
  expect(host.textContent).toContain("charged only if we accept your request");
  act(() => root.unmount());
});
