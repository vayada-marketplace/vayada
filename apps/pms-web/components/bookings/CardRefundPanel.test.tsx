import { createElement } from "react";
import { create, act } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import type { BookingCardRefund } from "@/services/bookings";
import { CardRefundPanel } from "./CardRefundPanel";

const { retryCardRefund } = vi.hoisted(() => ({ retryCardRefund: vi.fn() }));
vi.mock("@/services/bookings", () => ({ bookingsService: { retryCardRefund } }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: unknown }) =>
    createElement("a", { href, ...props }, children as never),
}));

const refund = (change: Partial<BookingCardRefund> = {}): BookingCardRefund => ({
  status: "pending",
  amount: "80.50",
  currency: "EUR",
  requestedBy: "guest",
  failureReason: null,
  createdAt: "2026-10-18T09:14:00.000Z",
  settledAt: null,
  ...change,
});
const booking = (cardRefund: BookingCardRefund | null) => ({
  id: "booking",
  cardRefund,
  totalAmount: 322,
  currency: "EUR",
  guestFirstName: "Lena",
  guestLastName: "Hoffmann",
});
const text = (view: ReturnType<typeof create>) => JSON.stringify(view.toJSON());

beforeEach(() => retryCardRefund.mockReset());

it("shows nothing for a stay without a card refund", () => {
  const view = create(
    createElement(CardRefundPanel, { booking: booking(null), onRetried: vi.fn() }),
  );
  expect(view.toJSON()).toBeNull();
});

it("says a refund is on its way, then that it is done, with who cancelled (VAY-2205)", () => {
  const pending = create(
    createElement(CardRefundPanel, { booking: booking(refund()), onRetried: vi.fn() }),
  );
  expect(text(pending)).toContain("Refund on its way to the guest's card");
  expect(text(pending)).toContain("€80.50 of €322.00");
  expect(text(pending)).toContain("the guest cancelled on");
  expect(pending.root.findAllByType("button")).toHaveLength(0);
  const done = create(
    createElement(CardRefundPanel, {
      booking: booking(
        refund({
          status: "succeeded",
          requestedBy: "host",
          settledAt: "2026-10-18T09:15:00.000Z",
        }),
      ),
      onRetried: vi.fn(),
    }),
  );
  expect(text(done)).toContain("Refunded to the guest's card");
  expect(text(done)).toContain("you cancelled");
  expect(text(done)).toContain("vayada's commission on the €80.50 went back to you.");
  // A deposit's refund reads against what the card paid, not the stay's total.
  const deposit = create(
    createElement(CardRefundPanel, {
      booking: booking(refund({ status: "succeeded", amount: "72.00", paidAmount: "72.00" })),
      onRetried: vi.fn(),
    }),
  );
  expect(text(deposit)).toContain("€72.00 of €72.00");
});

it.each([
  ["expired_or_canceled_card", "The guest's card has expired or was cancelled."],
  ["lost_or_stolen_card", "The card was reported lost or stolen."],
  ["insufficient_funds", "Your Stripe balance is too low for this refund."],
  ["generic_decline", "Stripe couldn't send it back."],
])("says why a refund failed in plain words (%s)", (failureReason, wording) => {
  const view = create(
    createElement(CardRefundPanel, {
      booking: booking(refund({ status: "failed", failureReason })),
      onRetried: vi.fn(),
    }),
  );
  expect(text(view)).toContain("The refund to the guest's card failed");
  expect(text(view)).toContain(wording);
});

it("retries a failed refund only after the confirm, then reloads the booking", async () => {
  retryCardRefund.mockResolvedValue({ status: "pending" });
  const onRetried = vi.fn();
  const view = create(
    createElement(CardRefundPanel, {
      booking: booking(refund({ status: "failed", failureReason: "expired_or_canceled_card" })),
      messageGuestHref: "/inbox?booking=booking",
      onRetried,
    }),
  );
  expect(view.root.findByType("a").props.href).toBe("/inbox?booking=booking");
  act(() => view.root.findByProps({ children: "Retry refund" }).props.onClick());
  expect(text(view)).toContain("Retry the refund?");
  expect(text(view)).toContain("send €80.50 back to Lena Hoffmann's card");
  expect(retryCardRefund).not.toHaveBeenCalled();
  const confirm = view.root.findAllByProps({ children: "Retry refund" }).at(-1)!;
  await act(async () => confirm.props.onClick());
  expect(retryCardRefund).toHaveBeenCalledWith("booking", expect.any(String));
  expect(onRetried).toHaveBeenCalledOnce();
  expect(text(view)).not.toContain("Retry the refund?");
});

it("says so when a refund is already being sent", async () => {
  retryCardRefund.mockResolvedValue({ status: "busy" });
  const onRetried = vi.fn();
  const view = create(
    createElement(CardRefundPanel, { booking: booking(refund({ status: "failed" })), onRetried }),
  );
  act(() => view.root.findByProps({ children: "Retry refund" }).props.onClick());
  const confirm = view.root.findAllByType("button").at(-1)!;
  expect(confirm.props.children).toBe("Retry refund");
  await act(async () => {
    await confirm.props.onClick();
  });
  expect(text(view)).toContain("This refund is already being sent.");
  expect(onRetried).toHaveBeenCalledOnce();
});
