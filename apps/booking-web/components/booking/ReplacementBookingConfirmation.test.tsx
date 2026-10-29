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
import { trackEvent } from "@/services/api/tracking";
import ReplacementBookingConfirmation from "./ReplacementBookingConfirmation";

vi.mock("@/services/api/tracking", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api/tracking")>()),
  trackEvent: vi.fn(),
}));
/** The funnel events sent so far (VAY-2197), never with anything about the guest. */
function funnel() {
  const calls = vi.mocked(trackEvent).mock.calls;
  expect(JSON.stringify(calls)).not.toMatch(/Ada|Lovelace|example\.test|\+49|Quiet|VAY-/);
  return calls.map(([, type, properties]) => [type, properties]);
}

vi.mock("@/services/api/pricingAcceptance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api/pricingAcceptance")>()),
  acceptPricingQuote: vi.fn(),
}));
const cardStep = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("./ReplacementCardPayment", () => ({
  default: (props: Record<string, unknown>) => {
    cardStep.props = props;
    return createElement("section", { "aria-label": "Card payment" });
  },
}));
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
// The guest's details come from the details step (VAY-2195).
const ada = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  phone: "+49 123",
  countryCode: "DE",
  arrivalTime: "17:30",
  specialRequests: "Quiet room",
};
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
function render(
  termsAccepted = true,
  rules: PublicQuoteGuestDisclosure | null = disclosure,
  guest: typeof ada | null = ada,
  onConsentMissing?: () => void,
) {
  act(() =>
    root.render(
      createElement(ReplacementBookingConfirmation, {
        slug: "hotel",
        quote,
        disclosure: rules,
        guest,
        termsAccepted,
        onConsentMissing,
      }),
    ),
  );
}
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

it("lets the guest press Confirm before ticking and points at the boxes instead (VAY-2306)", async () => {
  const missing = vi.fn();
  const confirm = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  render(false, null, ada, missing);
  expect(confirm().disabled).toBe(false);
  expect(document.body.textContent).not.toContain("Agree to the terms");
  await submit();
  expect(missing).toHaveBeenCalledTimes(1);
  expect(acceptPricingQuote).not.toHaveBeenCalled();
  expect(funnel()).toEqual([]);
  // Missing details still wait for the details step.
  render(false, null, null, missing);
  expect(confirm().disabled).toBe(true);
  expect(document.body.textContent).toContain("Fill in your details to book.");
  // Both ticked: Confirm books.
  render(true, disclosure, ada, missing);
  await submit();
  expect(missing).toHaveBeenCalledTimes(1);
  expect(acceptPricingQuote).toHaveBeenCalledTimes(1);
});

it("uses the chosen way's words on the button (VAY-2347)", () => {
  act(() =>
    root.render(
      createElement(ReplacementBookingConfirmation, {
        slug: "hotel",
        quote,
        disclosure,
        guest: ada,
        termsAccepted: true,
        label: "Weiter zu den Kartendaten",
        busyLabel: "Buchung wird bestätigt …",
      }),
    ),
  );
  expect(document.querySelector('button[type="submit"]')!.textContent).toBe(
    "Weiter zu den Kartendaten",
  );
});

it("waits for the guest's details from the details step", async () => {
  render(true, disclosure, null);
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(document.body.textContent).toContain("Fill in your details to book.");
  await submit();
  expect(acceptPricingQuote).not.toHaveBeenCalled();
});

it("books with the guest's details and shows the public confirmation reference", async () => {
  render();
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
  expect(funnel()).toEqual([
    ["complete_booking_clicked", { paymentMethod: "pay_at_property", mode: "instant" }],
    ["booking_completed", { paymentMethod: "pay_at_property", outcome: "confirmed" }],
  ]);
});

it("retires a rejected quote", async () => {
  render();
  vi.mocked(acceptPricingQuote).mockRejectedValueOnce(new ApiError("hidden", 409, null));
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "price is no longer available",
  );
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(funnel()[1]).toEqual([
    "booking_error",
    { step: "payment", reason: "price_expired", code: undefined },
  ]);
});

it("says nothing was booked when online booking is unavailable", async () => {
  render();
  vi.mocked(acceptPricingQuote).mockRejectedValueOnce(new ApiError("hidden", 404, null));
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "No room was reserved and no payment was taken",
  );
  // VAY-2163: a retry can't succeed, so the button stays off like the card-off case.
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
});

it("stops a request the hotel cannot receive online yet, without inviting a retry", async () => {
  act(() =>
    root.render(
      createElement(ReplacementBookingConfirmation, {
        slug: "hotel",
        quote: { ...quote, acceptanceMode: "request" } as PublicBookingQuote,
        disclosure,
        termsAccepted: true,
        guest: ada,
      }),
    ),
  );
  vi.mocked(acceptPricingQuote).mockRejectedValueOnce(
    new ApiError("hidden", 404, { code: "REQUEST_ACCEPTANCE_UNAVAILABLE" }),
  );
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "booking requests can’t be sent online yet",
  );
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(document.body.textContent).not.toContain("may still have reached us");
  expect(funnel()).toEqual([
    ["complete_booking_clicked", { paymentMethod: "pay_at_property", mode: "request" }],
    [
      "booking_error",
      { step: "payment", reason: "booking_unavailable", code: "REQUEST_ACCEPTANCE_UNAVAILABLE" },
    ],
  ]);
});

it("keeps an uncertain attempt retryable", async () => {
  render();
  vi.mocked(acceptPricingQuote).mockRejectedValueOnce(new Error("network"));
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "room may still have been booked",
  );
  const firstGuest = vi.mocked(acceptPricingQuote).mock.calls[0]![3];
  render(false, null, { ...ada, firstName: "Grace" });
  await submit();
  expect(acceptPricingQuote).toHaveBeenCalledTimes(2);
  expect(vi.mocked(acceptPricingQuote).mock.calls[1]![3]).toEqual(firstGuest);
  expect(vi.mocked(acceptPricingQuote).mock.calls[1]![3].firstName).toBe("Ada");
  expect(vi.mocked(acceptPricingQuote).mock.calls[1]!.slice(4)).toEqual([
    undefined,
    "uncertain-retry",
  ]);
  expect(document.body.textContent).toContain(result.bookingReference);
  // The retry is the same click; the booking is still counted once it is made.
  expect(funnel()).toEqual([
    ["complete_booking_clicked", { paymentMethod: "pay_at_property", mode: "instant" }],
    ["booking_error", { step: "payment", reason: "booking_uncertain", code: undefined }],
    ["booking_completed", { paymentMethod: "pay_at_property", outcome: "confirmed" }],
  ]);
});

// A card always takes something now, and the parts add up to the total; a deposit's rest is
// paid at the property (VAY-2205).
it.each([
  { paymentMethod: "card", dueNowMinor: "0", dueLaterMinor: "20000" },
  { acceptanceMode: "request", paymentMethod: "card", dueNowMinor: "5000", dueLaterMinor: "5000" },
] as const)("does not offer unsupported request or payment modes (%o)", (change) => {
  act(() =>
    root.render(
      createElement(ReplacementBookingConfirmation, {
        slug: "hotel",
        quote: { ...quote, ...change } as PublicBookingQuote,
        disclosure,
        termsAccepted: true,
        guest: ada,
      }),
    ),
  );
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    "not available for this payment option",
  );
});

it("sends a pay-at-property request and says the hotel still has to accept it", async () => {
  const request = { ...quote, acceptanceMode: "request" } as PublicBookingQuote;
  vi.mocked(acceptPricingQuote).mockResolvedValue({
    ...result,
    kind: "requested",
    hostResponseDeadlineAt: "2026-09-15T12:01:01.000Z",
  });
  act(() =>
    root.render(
      createElement(ReplacementBookingConfirmation, {
        slug: "hotel",
        quote: request,
        disclosure,
        termsAccepted: true,
        guest: ada,
      }),
    ),
  );
  const send = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(send.disabled).toBe(false);
  expect(send.textContent).toBe("Send booking request");
  await submit();
  expect(acceptPricingQuote).toHaveBeenCalledWith(
    "hotel",
    request,
    disclosure,
    expect.objectContaining({ email: "ada@example.test" }),
    undefined,
    "fresh",
  );
  expect(document.body.textContent).toContain("Booking request sent");
  expect(document.body.textContent).toContain("Nothing has been charged");
  expect(document.body.textContent).toContain(result.bookingReference);
  expect(document.body.textContent).not.toContain("Booking confirmed");
});

it("authorises a card request and says the card is charged only if the hotel accepts", async () => {
  const card = {
    ...quote,
    acceptanceMode: "request",
    paymentMethod: "card",
    dueNowMinor: "20000",
    dueLaterMinor: "0",
  };
  const required = {
    kind: "payment_required" as const,
    bookingId: result.bookingId,
    bookingReference: result.bookingReference,
    requestId: "accept-1",
    payment: {
      provider: "stripe" as const,
      clientSecret: "pi_1_secret_2",
      stripeAccountId: "acct_1",
      paymentIntentId: "pi_1",
      expiresAt: "2026-09-14T12:31:01.000Z",
    },
  };
  vi.mocked(acceptPricingQuote).mockResolvedValueOnce(required);
  act(() =>
    root.render(
      createElement(ReplacementBookingConfirmation, {
        slug: "hotel",
        quote: card as PublicBookingQuote,
        disclosure,
        termsAccepted: true,
        guest: ada,
      }),
    ),
  );
  expect(document.querySelector('button[type="submit"]')?.textContent).toBe(
    "Continue to card authorisation",
  );
  await submit();
  expect(cardStep.props).toMatchObject({ required, request: true });
  act(() =>
    (cardStep.props!.onPaid as (value: unknown) => void)({
      kind: "requested",
      bookingId: result.bookingId,
      bookingReference: result.bookingReference,
      replayed: false,
      hostResponseDeadlineAt: "2026-09-15T12:01:01.000Z",
    }),
  );
  expect(document.body.textContent).toContain("Booking request sent");
  expect(document.body.textContent).toContain("authorised but not charged");
  expect(document.body.textContent).not.toContain("Booking confirmed");
});

it("hands a fully paid card quote to the card step, then shows the confirmation", async () => {
  const card = { ...quote, paymentMethod: "card", dueNowMinor: "20000", dueLaterMinor: "0" };
  const required = {
    kind: "payment_required" as const,
    bookingId: result.bookingId,
    bookingReference: result.bookingReference,
    requestId: "accept-1",
    payment: {
      provider: "stripe" as const,
      clientSecret: "pi_1_secret_2",
      stripeAccountId: "acct_1",
      paymentIntentId: "pi_1",
      expiresAt: "2026-09-14T12:31:01.000Z",
    },
  };
  vi.mocked(acceptPricingQuote).mockResolvedValueOnce(required);
  act(() =>
    root.render(
      createElement(ReplacementBookingConfirmation, {
        slug: "hotel",
        quote: card as PublicBookingQuote,
        disclosure,
        termsAccepted: true,
        guest: ada,
      }),
    ),
  );
  expect(document.querySelector('button[type="submit"]')?.textContent).toBe(
    "Continue to card payment",
  );
  await submit();
  expect(document.querySelector('[aria-label="Card payment"]')).not.toBeNull();
  expect(cardStep.props).toMatchObject({ slug: "hotel", quoteId: quote.quoteId, required });
  act(() =>
    (cardStep.props!.onPaid as (value: unknown) => void)({
      kind: "accepted",
      bookingId: result.bookingId,
      bookingReference: result.bookingReference,
      replayed: false,
    }),
  );
  expect(document.body.textContent).toContain(result.bookingReference);
});

it("keeps an open attempt with the page, so a new form still retries it (VAY-2195)", async () => {
  const held = vi.fn();
  const renderHeld = (attempt: unknown, guest = ada) =>
    act(() =>
      root.render(
        createElement(ReplacementBookingConfirmation, {
          slug: "hotel",
          quote,
          disclosure,
          guest,
          termsAccepted: true,
          attempt: attempt as never,
          onAttemptChange: held,
        }),
      ),
    );
  renderHeld(null);
  vi.mocked(acceptPricingQuote).mockRejectedValueOnce(new Error("network"));
  await submit();
  const open = held.mock.calls.at(-1)![0];
  expect(open).toEqual({ quoteId: quote.quoteId, guest: ada, disclosure });
  // The guest left the step and came back: a fresh form gets the open attempt from the page.
  act(() => root.unmount());
  root = createRoot(document.getElementById("root")!);
  renderHeld(open, { ...ada, email: "other@example.test" });
  await submit();
  expect(vi.mocked(acceptPricingQuote).mock.calls[1]![3]).toEqual(ada);
  expect(vi.mocked(acceptPricingQuote).mock.calls[1]![5]).toBe("uncertain-retry");
});

it("hands a made booking to the page so it can open the confirmation (VAY-2195)", async () => {
  const booked = vi.fn();
  act(() =>
    root.render(
      createElement(ReplacementBookingConfirmation, {
        slug: "hotel",
        quote,
        disclosure,
        guest: ada,
        termsAccepted: true,
        onBooked: booked,
      }),
    ),
  );
  await submit();
  expect(booked).toHaveBeenCalledWith({
    bookingReference: result.bookingReference,
    requested: false,
  });
});

it("shows its button in “Your stay” and opens the card form where it is, in view (VAY-2416)", async () => {
  const card = { ...quote, paymentMethod: "card", dueNowMinor: "20000", dueLaterMinor: "0" };
  vi.mocked(acceptPricingQuote).mockResolvedValueOnce({
    kind: "payment_required" as const,
    bookingId: result.bookingId,
    bookingReference: result.bookingReference,
    requestId: "accept-1",
    payment: {
      provider: "stripe" as const,
      clientSecret: "pi_1_secret_2",
      stripeAccountId: "acct_1",
      paymentIntentId: "pi_1",
      expiresAt: "2026-09-14T12:31:01.000Z",
    },
  });
  // jsdom has no scrollIntoView.
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  const slot = document.createElement("div");
  document.body.append(slot);
  const view = (actionSlot: HTMLElement | null) =>
    act(() =>
      root.render(
        createElement(ReplacementBookingConfirmation, {
          slug: "hotel",
          quote: card as PublicBookingQuote,
          disclosure,
          termsAccepted: true,
          guest: ada,
          actionSlot,
          buttonClassName: "card-button",
        }),
      ),
    );
  // Nothing shows until the card's place exists.
  view(null);
  expect(document.querySelector("form")).toBeNull();
  view(slot);
  const button = slot.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  expect(button.textContent).toBe("Continue to card payment");
  expect(button.className).toBe("card-button");
  expect(document.getElementById("root")!.querySelector("form")).toBeNull();
  await act(async () => slot.querySelector("form")!.requestSubmit());
  expect(acceptPricingQuote).toHaveBeenCalledTimes(1);
  // The card form opens where the component is, not in the card, and is brought into view.
  expect(slot.querySelector("form")).toBeNull();
  expect(
    document.getElementById("root")!.querySelector('[aria-label="Card payment"]'),
  ).not.toBeNull();
  expect(scrolled).toHaveBeenCalledTimes(1);
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});
