/** @vitest-environment jsdom */
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import {
  completePricingCardPayment,
  type PricingCardPaymentRequired,
} from "@/services/api/pricingAcceptance";
import { trackEvent } from "@/services/api/tracking";
import ReplacementCardPayment from "./ReplacementCardPayment";

vi.mock("@/components/StripeProvider", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
const stripe = vi.hoisted(() => ({
  current: null as null | { confirmPayment: ReturnType<typeof vi.fn> },
}));
vi.mock("@stripe/react-stripe-js", () => ({
  PaymentElement: () => null,
  useStripe: () => stripe.current,
  useElements: () => (stripe.current ? {} : null),
}));
vi.mock("@/services/api/pricingAcceptance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api/pricingAcceptance")>()),
  completePricingCardPayment: vi.fn(),
}));
vi.mock("@/services/api/tracking", () => ({ trackEvent: vi.fn() }));

afterEach(() => {
  document.body.innerHTML = "";
  stripe.current = null;
  vi.clearAllMocks();
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

it.each([
  ["paid", {}, [["payment_authorized", { paymentMethod: "card" }]]],
  [
    "declined",
    { error: { type: "card_error", code: "card_declined", message: "Your card was declined." } },
    [["booking_error", { step: "payment", reason: "payment_failed" }]],
  ],
  [
    "not filled in yet",
    { error: { type: "validation_error", code: "incomplete_number", message: "Incomplete." } },
    [],
  ],
] as const)("reports a card that is %s to the funnel (VAY-2197)", async (_, outcome, events) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stripe.current = { confirmPayment: vi.fn().mockResolvedValue(outcome) };
  const result = { kind: "accepted", bookingReference: "VAY-1268" } as never;
  vi.mocked(completePricingCardPayment).mockResolvedValue(result);
  const onPaid = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      createElement(ReplacementCardPayment, {
        slug: "hotel-alpenrose",
        quoteId: "q",
        required: {
          bookingReference: "VAY-1268",
          requestId: "r",
          payment: { clientSecret: "pi_secret", expiresAt: "2026-10-14T20:15:00.000Z" },
        } as unknown as PricingCardPaymentRequired,
        onPaid,
      }),
    ),
  );
  await act(async () => host.querySelector("button")!.click());
  // Paid: the booking is handed on; refused: the guest sees why.
  await vi.waitFor(() =>
    expect(onPaid.mock.calls.length || host.querySelector('[role="alert"]')).toBeTruthy(),
  );
  if (!("error" in outcome)) expect(onPaid).toHaveBeenCalledWith(result);
  expect(
    vi.mocked(trackEvent).mock.calls.map(([, type, properties]) => [type, properties]),
  ).toEqual(events);
  // Never Stripe's code or message: they say something about the guest's card.
  expect(JSON.stringify(vi.mocked(trackEvent).mock.calls)).not.toMatch(/card_declined|incomplete/);
  act(() => root.unmount());
});
