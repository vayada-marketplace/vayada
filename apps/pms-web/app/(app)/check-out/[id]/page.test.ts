import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBooking: vi.fn(),
  completeCheckOut: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock("next/link", () => ({ default: "a" }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "booking-1" }),
  useRouter: () => ({}),
}));
vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({ locale: "en", t: mocks.translate }),
}));
vi.mock("@/services/settings", () => ({
  settingsService: { getCheckoutInspection: async () => ({ steps: [] }) },
}));
vi.mock("@/services/bookings", () => ({
  bookingsService: {
    get: mocks.getBooking,
    completeCheckOut: mocks.completeCheckOut,
    listCheckoutCharges: async () => ({ charges: [] }),
    listNotes: async () => ({ notes: [] }),
  },
}));

import CheckOutPage from "./page";

const booking = {
  id: "booking-1",
  bookingReference: "VAY-1",
  status: "checked_in",
  guestFirstName: "Ada",
  guestLastName: "Lovelace",
  roomName: "Suite",
  roomNumber: "101",
  assignedRooms: [],
  checkIn: "2026-09-14",
  checkOut: "2026-09-15",
  nights: 1,
  adults: 1,
  children: 0,
  numberOfGuests: 1,
  totalAmount: 100,
  currency: "EUR",
  addonIds: ["breakfast", "parking"],
  addonSelections: [
    { selectionId: "selection-1", addonId: "breakfast", name: "Breakfast", quantity: 2 },
    { selectionId: "selection-2", addonId: "parking", name: "Parking", quantity: 1 },
  ],
};

let view: ReactTestRenderer;

beforeEach(() => {
  mocks.getBooking.mockResolvedValue(booking);
  mocks.completeCheckOut.mockResolvedValue({ ...booking, status: "checked_out" });
});

afterEach(() => {
  act(() => view?.unmount());
  vi.clearAllMocks();
});

async function mount() {
  await act(async () => {
    view = create(createElement(CheckOutPage));
  });
}

function completeButton() {
  return view.root
    .findAllByType("button")
    .find((button) => button.children.includes("checkOut.complete"))!;
}

it("blocks checkout when the API cannot identify purchased selections", async () => {
  mocks.getBooking.mockResolvedValue({ ...booking, addonSelections: undefined });

  await mount();

  expect(JSON.stringify(view.toJSON())).toContain("checkOut.addonClassificationUnavailable");
  expect(completeButton().props.disabled).toBe(true);
  expect(mocks.completeCheckOut).not.toHaveBeenCalled();
});

it("requires every named selection and submits only those marked fulfilled", async () => {
  await mount();
  expect(completeButton().props.disabled).toBe(true);

  const breakfastFulfilled = view.root.findByProps({
    "aria-label": "Breakfast: checkOut.addonFulfilled",
  });
  const parkingNotConfirmed = view.root.findByProps({
    "aria-label": "Parking: checkOut.addonNotConfirmed",
  });

  act(() => breakfastFulfilled.props.onClick());
  expect(completeButton().props.disabled).toBe(true);
  act(() => parkingNotConfirmed.props.onClick());
  expect(completeButton().props.disabled).toBe(false);

  await act(async () => completeButton().props.onClick());

  expect(mocks.completeCheckOut).toHaveBeenCalledWith(
    "booking-1",
    [],
    [],
    undefined,
    ["selection-1"],
  );
});
