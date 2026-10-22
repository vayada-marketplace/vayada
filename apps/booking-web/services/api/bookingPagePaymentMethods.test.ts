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
    termsText: null,
    extras: {},
    groupExtras: true,
  });
  // An older API without the list keeps card and pay at property.
  mocks.get.mockResolvedValue({});
  expect(await getBookingPagePayment("hotel")).toEqual({
    methods: ["card", "pay_at_property"],
    earliestArrival: {},
    termsText: null,
    extras: {},
    groupExtras: true,
  });
});

it("reads the hotel's own terms from the same response, and none when blank or unreadable (VAY-2176)", async () => {
  mocks.get.mockResolvedValueOnce({ termsText: "  Our terms.\n\n1. Booking  " });
  expect((await getBookingPagePayment("hotel")).termsText).toBe("Our terms.\n\n1. Booking");
  for (const config of [{ termsText: "   " }, {}, { termsText: 3 }, null]) {
    mocks.get.mockResolvedValueOnce(config);
    expect((await getBookingPagePayment("hotel")).termsText).toBeNull();
  }
  mocks.get.mockRejectedValueOnce(new Error("Too many requests"));
  expect(await getBookingPagePayment("hotel")).toEqual({
    methods: ["card", "pay_at_property"],
    earliestArrival: {},
    termsText: null,
    extras: {},
    groupExtras: true,
  });
  expect(mocks.get).toHaveBeenCalledTimes(6);
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

it("reads how the extras step shows each extra (VAY-2195)", async () => {
  mocks.get.mockResolvedValue({
    addons: [
      {
        id: "breakfast",
        description: " Fresh bread. ",
        price: 18,
        category: "dining",
        image: "",
        images: [
          "https://elsewhere.example/b.jpg",
          "https://images.vayada.com/media/b.webp",
          "https://images.vayada.com/media/c.webp",
          "https://images.vayada.com/media/b.webp",
        ],
        duration: " 2 hours ",
        location: "Garden terrace",
      },
      { id: "spa", price: "35.50", category: "massage", image: "javascript:alert(1)" },
      { id: 7 },
      null,
    ],
    groupAddonsByCategory: false,
  });
  expect((await getBookingPagePayment("hotel")).extras).toEqual({
    breakfast: {
      description: "Fresh bread.",
      image: "https://images.vayada.com/media/b.webp",
      // VAY-2231: the details show every allowed photo once, and the facts the hotel filled in.
      photos: ["https://images.vayada.com/media/b.webp", "https://images.vayada.com/media/c.webp"],
      duration: "2 hours",
      location: "Garden terrace",
      category: "dining",
      price: 18,
    },
    spa: {
      description: "",
      image: null,
      photos: [],
      duration: null,
      location: null,
      category: "other",
      price: 35.5,
    },
  });
  expect((await getBookingPagePayment("hotel")).groupExtras).toBe(false);
});
