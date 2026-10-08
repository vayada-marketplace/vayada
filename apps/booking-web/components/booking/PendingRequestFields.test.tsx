/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import type { RoomSelection } from "@/lib/types";
import type { BookingCreateRequest } from "@/services/api/booking";
import type { PendingEditDetails } from "@/services/api/pendingBookingEdits";
import PendingRequestFields from "./PendingRequestFields";
const selection: RoomSelection = {
  contractVersion: "booking-room-selection.v1",
  lines: [
    {
      roomTypeId: "double",
      publicOfferKey: "double:flex",
      guests: [
        { adults: 2, children: 0 },
        { adults: 2, children: 0 },
      ],
    },
    { roomTypeId: "twin", publicOfferKey: "twin:nrf", guests: [{ adults: 2, children: 0 }] },
  ],
};
const input = {
  roomTypeId: "double",
  roomSelection: selection,
  checkIn: "2027-02-01",
  checkOut: "2027-02-03",
  adults: 6,
  children: 0,
  numberOfRooms: 3,
  paymentMethod: "pay_at_property",
} as BookingCreateRequest;
const details = { input, booking: { roomName: "2 × Double + 1 × Twin" } } as PendingEditDetails;
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
async function render(value: BookingCreateRequest, change = vi.fn()) {
  await act(async () =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale: "en",
        messages: en,
        children: createElement(PendingRequestFields, {
          input: value,
          details,
          settings: null,
          addons: [],
          disabled: false,
          change,
        }),
      }),
    ),
  );
  return change;
}
it("prefills held mixed rooms even when public search cannot offer them", async () => {
  await render(input);
  expect(document.querySelector("select")!.selectedOptions[0].textContent).toBe(
    details.booking.roomName,
  );
  const count = document.querySelector<HTMLInputElement>("input[readonly]")!;
  expect(count.value).toBe("3");
  expect(count.readOnly).toBe(true);
});
it("blocks price review after a party change until allocations match", async () => {
  await render({ ...input, adults: 7 });
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')!.textContent).toBe(en.roomSelection.partyChanged);
});

it("reallocates held rooms without public stock and preserves every room and rate", async () => {
  const changedParty = { ...input, adults: 5 };
  const change = await render(changedParty, vi.fn());
  const allocationFields = document.querySelectorAll<HTMLInputElement>(
    'fieldset fieldset input[type="number"]',
  );
  expect(allocationFields).toHaveLength(6);
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      allocationFields[4],
      "1",
    );
    allocationFields[4].dispatchEvent(new Event("input", { bubbles: true }));
  });
  const updated = { ...changedParty, ...change.mock.lastCall![0] };
  expect(updated.roomSelection).toEqual({
    ...selection,
    lines: [selection.lines[0], { ...selection.lines[1], guests: [{ adults: 1, children: 0 }] }],
  });
  expect(selection.lines[1].guests[0].adults).toBe(2);
  await render(updated, change);
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector<HTMLInputElement>("input[readonly]")!.value).toBe("3");
});

it("restores the held original selection from a changed room", async () => {
  const change = await render({ ...input, roomTypeId: "suite", roomSelection: undefined });
  const select = document.querySelector<HTMLSelectElement>("select")!;
  expect(select.value).toBe("current-selection");
  act(() => {
    select.value = "original-selection";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(change).toHaveBeenLastCalledWith({
    roomTypeId: input.roomTypeId,
    roomSelection: selection,
    numberOfRooms: 3,
    currency: undefined,
  });
});
