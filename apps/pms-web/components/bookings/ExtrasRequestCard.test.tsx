import { createElement } from "react";
import { create, act } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { ExtrasRequestCard } from "./ExtrasRequestCard";
import type { BookingExtrasRequest } from "@/services/bookings";
const item = (
  name: string,
  pricingModel: BookingExtrasRequest["items"][number]["pricingModel"],
  unitMinor: string,
  amountMinor: string,
) => ({
  addonId: name,
  name,
  pricingModel,
  unitMinor,
  amountMinor,
  currency: "EUR",
  guests: 2,
  nights: 3,
});
const request = (status: BookingExtrasRequest["status"]): BookingExtrasRequest => ({
  id: "request",
  status,
  items: [
    item("Airport transfer", "per_stay", "2500", "2500"),
    item("Breakfast", "per_guest_night", "1800", "10800"),
  ],
  totalMinor: "13300",
  currency: "EUR",
  createdAt: "2026-10-20T09:00:00.000Z",
  decidedAt: status === "pending" ? null : "2026-10-21T09:00:00.000Z",
  note: null,
});
const text = (view: ReturnType<typeof create>) => JSON.stringify(view.toJSON());
const button = (view: ReturnType<typeof create>, label: string) =>
  view.root
    .findAllByType("button")
    .find((candidate) => [candidate.props.children].flat().includes(label))!;

it("lists a waiting request's extras, how each is priced, and the total to charge at check-in", () => {
  const view = create(
    createElement(ExtrasRequestCard, {
      request: request("pending"),
      guestName: "Ada Lovelace",
      busy: false,
      onDecide: vi.fn(),
    }),
  );
  const shown = text(view);
  for (const words of [
    "Extras requested by the guest",
    "Ada Lovelace",
    "Airport transfer",
    "per stay",
    "€25.00",
    "€18.00 per guest per night",
    "2 guests",
    "3 nights",
    "€108.00",
    "To charge at check-in",
    "€133.00",
  ])
    expect(shown).toContain(words);
  view.unmount();
});
it("accepts, or declines with the reason for the guest", () => {
  const onDecide = vi.fn();
  const view = create(
    createElement(ExtrasRequestCard, {
      request: request("pending"),
      guestName: "",
      busy: false,
      onDecide,
    }),
  );
  expect(text(view)).toContain("The guest asked");
  act(() => button(view, "Accept extras").props.onClick());
  expect(onDecide).toHaveBeenLastCalledWith("accept");
  act(() => button(view, "Decline").props.onClick());
  act(() =>
    view.root.findByType("textarea").props.onChange({ target: { value: "  Fully booked  " } }),
  );
  act(() => button(view, "Decline extras").props.onClick());
  expect(onDecide).toHaveBeenLastCalledWith("decline", "Fully booked");
  view.unmount();
});
it("disables its buttons while an answer is saving", () => {
  const view = create(
    createElement(ExtrasRequestCard, {
      request: request("pending"),
      guestName: "Ada",
      busy: true,
      onDecide: vi.fn(),
    }),
  );
  expect(view.root.findAllByType("button").every((candidate) => candidate.props.disabled)).toBe(
    true,
  );
  view.unmount();
});
it("shows an accepted request without buttons, and a declined one as a single line", () => {
  const accepted = create(
    createElement(ExtrasRequestCard, {
      request: request("accepted"),
      guestName: "Ada",
      busy: false,
      onDecide: vi.fn(),
    }),
  );
  expect(text(accepted)).toContain("Extras accepted on");
  expect(text(accepted)).toContain("€133.00");
  expect(accepted.root.findAllByType("button")).toHaveLength(0);
  accepted.unmount();
  const declined = create(
    createElement(ExtrasRequestCard, {
      request: request("declined"),
      guestName: "Ada",
      busy: false,
      onDecide: vi.fn(),
    }),
  );
  expect(text(declined)).toContain("Extras declined on");
  expect(text(declined)).toContain("Airport transfer, Breakfast");
  expect(declined.root.findAllByType("button")).toHaveLength(0);
  declined.unmount();
  for (const status of ["canceled", "expired"] as const) {
    const gone = create(
      createElement(ExtrasRequestCard, {
        request: request(status),
        guestName: "Ada",
        busy: false,
        onDecide: vi.fn(),
      }),
    );
    expect(gone.toJSON()).toBeNull();
    gone.unmount();
  }
});
