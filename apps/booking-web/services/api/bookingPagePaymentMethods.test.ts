import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./client", () => ({ bookingWebPublic: { get: mocks.get } }));

import { bookingPageMethodsForArrival, getBookingPagePayment } from "./bookingPagePaymentMethods";

beforeEach(() => mocks.get.mockReset());

it("reads the earliest arrival date for bank transfer and PayPal (VAY-2145)", async () => {
  mocks.get.mockResolvedValue({
    bookingPagePaymentMethods: ["pay_at_property", "bank_transfer", "paypal"],
    manualPaymentEarliestArrival: {
      bank_transfer: "2026-10-14",
      paypal: "bad",
      card: "2026-10-12",
    },
  });
  expect(await getBookingPagePayment("hotel")).toEqual({
    methods: ["pay_at_property", "bank_transfer", "paypal"],
    earliestArrival: { bank_transfer: "2026-10-14" },
  });
  // An older API without the list keeps card and pay at property.
  mocks.get.mockResolvedValue({});
  expect(await getBookingPagePayment("hotel")).toEqual({
    methods: ["card", "pay_at_property"],
    earliestArrival: {},
  });
});

it("offers bank transfer and PayPal only from their earliest arrival date (VAY-2145)", () => {
  const payment = {
    methods: ["pay_at_property", "bank_transfer", "paypal"] as const,
    earliestArrival: { bank_transfer: "2026-10-14", paypal: "2026-10-13" },
  };
  const offered = (checkIn: string) =>
    bookingPageMethodsForArrival({ ...payment, methods: [...payment.methods] }, checkIn);
  expect(offered("2026-10-12")).toEqual(["pay_at_property"]);
  expect(offered("2026-10-13")).toEqual(["pay_at_property", "paypal"]);
  expect(offered("2026-10-14")).toEqual(["pay_at_property", "bank_transfer", "paypal"]);
  // No dates chosen yet: everything the hotel offers.
  expect(offered("")).toEqual(["pay_at_property", "bank_transfer", "paypal"]);
  // Without a date from the API (older API) the method stays.
  expect(
    bookingPageMethodsForArrival({ methods: ["paypal"], earliestArrival: {} }, "2026-10-12"),
  ).toEqual(["paypal"]);
});
