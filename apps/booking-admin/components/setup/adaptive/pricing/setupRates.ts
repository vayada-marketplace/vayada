import type { PaymentMethod } from "@vayada/product-onboarding/AcceptedPaymentMethods";
import { firstPricingInput, type SetupRoom } from "@vayada/product-onboarding/FirstPricingSetup";
import type { FinancePaymentReadinessSnapshot } from "@vayada/domain-finance";
import {
  defaultPaidWhenBookingPayment,
  paidWhenBooking,
} from "@vayada/domain-booking/replacement-pricing";

import type { FirstPricing } from "./publishFirstPricing";

/** The setup step's one cancellation choice for every room (VAY-2188). */
export type SetupCancellation = { kind: "free"; days: number } | { kind: "non_refundable" };
export const freeCancellationDays = [1, 2, 3, 5, 7, 14, 30] as const;
export const defaultCancellation: SetupCancellation = { kind: "free", days: 3 };

/** How guests pay, as chosen in the Payments step: the selected methods that are ready, plus bank transfer and PayPal
 * when the hotel takes them (`manual`). Null when none is ready: the step then asks. */
export function paymentsStepMethods(
  readiness: FinancePaymentReadinessSnapshot,
  manual: readonly PaymentMethod[],
): PaymentMethod[] | null {
  const chosen = readiness.methods
    .filter(
      (item) =>
        item.selected &&
        item.readiness === "ready" &&
        (item.method === "pay_at_property" || item.method === "card"),
    )
    .map((item) => item.method as PaymentMethod);
  const methods = [...chosen, ...manual.filter((method) => !chosen.includes(method))];
  return methods.length ? methods : null;
}

/** One first rate per room from its price per night (VAY-2188): one price for the room, the step's cancellation and
 * ways to pay, children under 12 free and no minimum stay. Seasons, meals and more are added later in the PMS.
 * "Paid when booking" starts as the PMS's default (VAY-2205): a flexible rate is paid at the property when the hotel
 * takes that, every other rate in full when booking.
 * `offerId` names each room's offer; a retry passes the same ids. Throws the first price that doesn't parse. */
export function setupRates(
  propertyId: string,
  rooms: readonly SetupRoom[],
  prices: Readonly<Record<string, string>>,
  currency: string,
  cancellation: SetupCancellation,
  methods: readonly PaymentMethod[],
  offerId: (roomTypeId: string) => string = () => crypto.randomUUID(),
): FirstPricing[] {
  const kind = cancellation.kind === "free" ? "flexible" : "non_refundable";
  const first = defaultPaidWhenBookingPayment(kind, methods);
  // None fits: the builder names what's missing.
  const payment = first ? paidWhenBooking(first) : "full_stay";
  return rooms.map((room) =>
    firstPricingInput(propertyId, room, offerId(room.roomTypeId), {
      mode: "flat",
      occupancy: [],
      included: { adults: "", adjustments: [] },
      methods: [...methods],
      room: room.roomTypeId,
      currency,
      base: prices[room.roomTypeId] ?? "",
      adultAge: "12",
      childPrice: "0",
      countChildren: "yes",
      minimum: "1",
      maximum: "",
      cancellation: cancellation.kind === "free" ? "flexible" : "non_refundable",
      freeDays: cancellation.kind === "free" ? String(cancellation.days) : "",
      payment,
    }),
  );
}
