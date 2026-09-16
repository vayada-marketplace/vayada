/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  PublicBookingQuote,
  PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import { ApiError } from "@/services/api/client";
import { acceptPricingQuote } from "@/services/api/pricingAcceptance";
import ReplacementBookingConfirmation from "./ReplacementBookingConfirmation";

vi.mock("@/services/api/pricingAcceptance", () => ({ acceptPricingQuote: vi.fn() }));
const quote = {
  quoteId: "11111111-1111-4111-8111-111111111111",
  acceptanceMode: "instant",
  paymentMethod: "pay_at_property",
  dueNowMinor: "0",
  dueLaterMinor: "20000",
  totalMinor: "20000",
} as PublicBookingQuote;
const disclosure = {
  quoteId: quote.quoteId,
  choices: {
    phoneRequired: true,
    arrivalTimeEnabled: true,
    specialRequestsEnabled: true,
  },
} as PublicQuoteGuestDisclosure;
const result = {
  kind: "accepted" as const,
  bookingId: "22222222-2222-4222-8222-222222222222",
  bookingReference: "VAY-22222222222242228222222222222222",
  acceptanceId: "33333333-3333-4333-8333-333333333333",
  acceptedAt: "2026-09-14T12:01:01.000Z",
  checkedAt: "2026-09-14T12:01:02.000Z",
};
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  vi.mocked(acceptPricingQuote).mockResolvedValue(result);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
function render(termsAccepted = true, rules: PublicQuoteGuestDisclosure | null = disclosure) {
  act(() =>
    root.render(
      createElement(ReplacementBookingConfirmation, {
        slug: "hotel",
        quote,
        disclosure: rules,
        termsAccepted,
      }),
    ),
  );
}
const input = (name: string) => document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
async function submit() {
  await act(async () => document.querySelector<HTMLFormElement>("form")!.requestSubmit());
}

it("stays blocked until both exact consent sources are present", async () => {
  render(false);
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  await submit();
  expect(acceptPricingQuote).not.toHaveBeenCalled();
  render(true, { ...disclosure, quoteId: "other" });
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
});

it("collects only enabled policy fields and shows the public confirmation reference", async () => {
  render();
  expect(input("phone").required).toBe(true);
  expect(input("arrivalTime")).not.toBeNull();
  expect(document.querySelector('[name="specialRequests"]')).not.toBeNull();
  for (const [name, value] of [
    ["firstName", "Ada"],
    ["lastName", "Lovelace"],
    ["email", "ada@example.test"],
    ["phone", "+49 123"],
    ["countryCode", "DE"],
    ["arrivalTime", "17:30"],
    ["specialRequests", "Quiet room"],
  ])
    input(name).value = value;
  await submit();
  expect(acceptPricingQuote).toHaveBeenCalledWith(
    "hotel",
    quote,
    disclosure,
    {
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.test",
      phone: "+49 123",
      countryCode: "DE",
      arrivalTime: "17:30",
      specialRequests: "Quiet room",
    },
    undefined,
    "fresh",
  );
  expect(document.body.textContent).toContain("Booking confirmed");
  expect(document.body.textContent).toContain(result.bookingReference);
  expect(document.querySelector("form")).toBeNull();
});

it("retires a rejected quote", async () => {
  render();
  input("firstName").value = "Ada";
  input("lastName").value = "Lovelace";
  input("email").value = "ada@example.test";
  input("phone").value = "+49";
  vi.mocked(acceptPricingQuote).mockRejectedValueOnce(new ApiError("hidden", 409, null));
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "price is no longer available",
  );
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
});

it("keeps an uncertain attempt retryable", async () => {
  render();
  input("firstName").value = "Ada";
  input("lastName").value = "Lovelace";
  input("email").value = "ada@example.test";
  input("phone").value = "+49";
  vi.mocked(acceptPricingQuote).mockRejectedValueOnce(new Error("network"));
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "room may still have been booked",
  );
  expect(input("firstName").disabled).toBe(true);
  const firstGuest = vi.mocked(acceptPricingQuote).mock.calls[0]![3];
  input("firstName").value = "Grace";
  render(false, null);
  await submit();
  expect(acceptPricingQuote).toHaveBeenCalledTimes(2);
  expect(vi.mocked(acceptPricingQuote).mock.calls[1]![3]).toEqual(firstGuest);
  expect(vi.mocked(acceptPricingQuote).mock.calls[1]![3].firstName).toBe("Ada");
  expect(vi.mocked(acceptPricingQuote).mock.calls[1]!.slice(4)).toEqual([
    undefined,
    "uncertain-retry",
  ]);
  expect(document.body.textContent).toContain(result.bookingReference);
});

it("does not offer unsupported request or payment modes", () => {
  act(() =>
    root.render(
      createElement(ReplacementBookingConfirmation, {
        slug: "hotel",
        quote: { ...quote, paymentMethod: "card" },
        disclosure,
        termsAccepted: true,
      }),
    ),
  );
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    "not available for this payment option",
  );
});
