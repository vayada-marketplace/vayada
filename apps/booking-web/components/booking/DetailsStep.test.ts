import { expect, it } from "vitest";
import type {
  PublicBookingQuote,
  PublicQuoteGuestDisclosure,
} from "@vayada/domain-booking/replacement-pricing";
import { rateTerms, ruleLines } from "./DetailsStep";

type Room = PublicBookingQuote["rooms"][number];
const payment = { kind: "full", acceptedMethods: ["pay_at_property"] } as Room["payment"];

it("words each kind of cancellation for the guest (VAY-2195)", () => {
  expect(
    rateTerms({
      selectionId: "a",
      mealPlan: "room_only",
      cancellation: { kind: "non_refundable" },
      payment,
    } as Room),
  ).toEqual([
    "Meals: room only.",
    "Cancellation: non-refundable. If you cancel, change or don’t arrive, we charge the full amount.",
  ]);
  expect(
    rateTerms({
      selectionId: "a",
      mealPlan: "breakfast",
      cancellation: {
        kind: "flexible",
        terms: {
          flexibleCancellationType: "free",
          freeCancellationDeadlineDays: 3,
          text: "Call us.",
        },
      },
      payment,
    } as unknown as Room),
  ).toEqual([
    "Meals: breakfast.",
    "Cancellation: free until 3 days before arrival. After that, or if you don’t arrive, we charge the full amount.",
    "Call us.",
  ]);
  const partial = rateTerms({
    selectionId: "a",
    mealPlan: "room_only",
    cancellation: {
      kind: "flexible",
      terms: {
        flexibleCancellationType: "partial_refund",
        partialRefundTiers: [
          { minDaysBeforeCheckIn: 7, refundPercent: 50 },
          { minDaysBeforeCheckIn: 30, refundPercent: 100 },
        ],
      },
    },
    payment,
  } as unknown as Room);
  // Most notice first, as on the payment terms (VAY-2100).
  expect(partial[1]).toBe(
    "Cancellation: 100% back with at least 30 days’ notice; 50% back with at least 7 days’ notice. With less notice, or if you don’t arrive, we keep the full amount.",
  );
});

it("words our guest rules for the details step (VAY-2195)", () => {
  const lines = ruleLines({
    propertyTimeZone: "Europe/Berlin",
    choices: {
      checkInTime: "15:00",
      checkInUntil: "00:00",
      checkOutFrom: "06:00",
      checkOutTime: "11:00",
      childrenEnabled: false,
      adultAgeThreshold: 16,
      phoneRequired: false,
      arrivalTimeEnabled: true,
      specialRequestsEnabled: false,
    },
  } as PublicQuoteGuestDisclosure);
  expect(Object.fromEntries(lines)).toEqual({
    "Check-in": "From 15:00 until midnight at the end of your arrival day",
    "Check-out": "From 06:00, by 11:00",
    Children: "We do not accommodate children. Guests from 16 count as adults.",
    "Phone number": "Optional",
    "Arrival time and requests": "You can tell us your arrival time",
  });
});
