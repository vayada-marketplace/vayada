import { createElement } from "react";
import { create, act } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import { AirbnbChangeRequestCard } from "./AirbnbChangeRequestCard";
import type { BookingChangeRequest } from "@/services/bookings";
const request = (
  state: NonNullable<BookingChangeRequest["providerRequest"]>["state"] = "pending",
): BookingChangeRequest => ({
  id: "request",
  bookingId: "booking",
  status: "pending",
  oldCheckIn: "2026-10-01",
  oldCheckOut: "2026-10-03",
  requestedCheckIn: "2026-10-01",
  requestedCheckOut: "2026-10-05",
  oldTotal: 300,
  newTotal: 0,
  priceDifference: 0,
  currency: "EUR",
  oldAddonIds: [],
  oldAddonQuantities: {},
  oldAddonDates: {},
  requestedAddonIds: [],
  requestedAddonQuantities: {},
  requestedAddonDates: {},
  requestedAddonNames: [],
  declineReason: null,
  decidedAt: null,
  createdAt: "2026-09-08",
  providerRequest: {
    provider: "airbnb",
    state,
    allowedActions: [],
    refreshAction: null,
    oldTotal: 300,
    newTotal: null,
    priceDifference: null,
    currency: "EUR",
    oldAdults: 2,
    oldChildren: 0,
    requestedAdults: 3,
    requestedChildren: 0,
  },
});
it("shows missing prices honestly and disables inactive actions", () => {
  const view = create(
    createElement(AirbnbChangeRequestCard, { request: request(), busy: false, onDecide: vi.fn() }),
  );
  expect(JSON.stringify(view.toJSON())).toContain("Not provided");
  expect(JSON.stringify(view.toJSON())).not.toContain("€0.00");
  expect(view.root.findAllByType("button").every((button) => button.props.disabled)).toBe(true);
  view.unmount();
});
it.each(["accept", "decline"] as const)("sends only the permitted %s action", (action) => {
  const value = request("queued");
  value.providerRequest!.allowedActions = [action];
  const onDecide = vi.fn();
  const view = create(
    createElement(AirbnbChangeRequestCard, { request: value, busy: false, onDecide }),
  );
  const enabled = view.root.findAllByType("button").filter((button) => !button.props.disabled);
  expect(enabled).toHaveLength(1);
  act(() => enabled[0]!.props.onClick());
  expect(onDecide).toHaveBeenCalledWith(action);
  view.unmount();
});
it("offers only same-intent status checking after an uncertain send", () => {
  const value = request("unknown");
  value.providerRequest!.refreshAction = "decline";
  const onDecide = vi.fn();
  const view = create(
    createElement(AirbnbChangeRequestCard, { request: value, busy: false, onDecide }),
  );
  const button = view.root.findByType("button");
  expect(button.children.join("")).toBe("Check Airbnb status");
  act(() => button.props.onClick());
  expect(onDecide).toHaveBeenCalledWith("decline");
  view.unmount();
});
it.each(["awaiting_confirmation", "declined", "withdrawn", "applied"] as const)(
  "prevents further decisions in %s",
  (state) => {
    const view = create(
      createElement(AirbnbChangeRequestCard, {
        request: request(state),
        busy: false,
        onDecide: vi.fn(),
      }),
    );
    expect(view.root.findAllByType("button")).toHaveLength(0);
    expect(view.root.findByProps({ role: "status" })).toBeTruthy();
    view.unmount();
  },
);

it("disables controls while a decision is in flight", () => {
  const value = request();
  value.providerRequest!.allowedActions = ["accept", "decline"];
  const view = create(
    createElement(AirbnbChangeRequestCard, { request: value, busy: true, onDecide: vi.fn() }),
  );
  expect(view.root.findByType("section").props["aria-busy"]).toBe(true);
  expect(view.root.findAllByType("button").every((button) => button.props.disabled)).toBe(true);
  view.unmount();
});
