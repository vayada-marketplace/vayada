export const FUNNEL_STAGES = [
  "page_visit",
  "rate_selected",
  "addons_step_passed",
  "details_completed",
  "complete_booking_clicked",
  "payment_authorized",
  "booking_completed",
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];
/**
 * Funnel telemetry the public endpoint accepts. room_viewed stays tracked as a standalone
 * metric but is not a stage: guests can select a rate without opening room details (VAY-2074).
 * Neither are step_viewed and booking_error: they show where guests leave the /book steps
 * (VAY-2197).
 */
export const FUNNEL_EVENT_TYPES = [
  ...FUNNEL_STAGES,
  "room_viewed",
  "step_viewed",
  "booking_error",
] as const;
export type FunnelEventType = (typeof FUNNEL_EVENT_TYPES)[number];
export const FUNNEL_PAYMENT_METHODS = [
  "card",
  "bank_transfer",
  "pay_at_property",
  "xendit",
  "paypal",
] as const;
export type FunnelPaymentMethod = (typeof FUNNEL_PAYMENT_METHODS)[number];
/** The /book steps (VAY-2195). */
export const FUNNEL_STEPS = ["rooms", "extras", "details", "payment"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
export const FUNNEL_ERROR_REASONS = [
  "price_expired",
  "price_refused",
  "pricing_failed",
  "booking_unavailable",
  "booking_uncertain",
  "payment_failed",
] as const;
/** Our own API's refusal codes; never a payment provider's decline code. */
export const FUNNEL_ERROR_CODES = [
  "QUOTE_REFRESH_REQUIRED",
  "PRICING_UNAVAILABLE",
  "PRICING_RETIRED",
  "PROMO_CODES_UNAVAILABLE",
  "ADDONS_UNAVAILABLE",
  "MANUAL_PAYMENT_TOO_SOON",
  "MANUAL_PAYMENT_UNAVAILABLE",
  "CARD_PAYMENT_UNAVAILABLE",
  "REQUEST_ACCEPTANCE_UNAVAILABLE",
] as const;

/**
 * Everything a funnel event may carry besides funnelVersion and funnelSequence (VAY-2197).
 * Pseudonymous by design: no guest details, free text, dates, amounts, or ids that lead to a
 * quote or booking. Booking Web builds its events from this and the public endpoint enforces it.
 */
export type FunnelEventProperties = {
  page_visit: Record<string, never>;
  room_viewed: { roomTypeId: string };
  rate_selected: { entry: "room_card" | "rooms_form" };
  step_viewed: { step: FunnelStep };
  addons_step_passed: { extrasShown: boolean; extrasChosen: boolean };
  details_completed: Record<string, never>;
  complete_booking_clicked: { paymentMethod: FunnelPaymentMethod; mode: "instant" | "request" };
  payment_authorized: { paymentMethod: "card" };
  booking_completed: {
    paymentMethod: FunnelPaymentMethod;
    outcome: "confirmed" | "requested" | "awaiting_payment";
  };
  booking_error: {
    step: FunnelStep;
    reason: (typeof FUNNEL_ERROR_REASONS)[number];
    code?: (typeof FUNNEL_ERROR_CODES)[number];
  };
};

type Rule = { valid: (value: unknown) => boolean; optional?: boolean };
const oneOf = (values: readonly unknown[]): Rule => ({ valid: (value) => values.includes(value) });
const flag: Rule = { valid: (value) => typeof value === "boolean" };
const method = oneOf(FUNNEL_PAYMENT_METHODS);
// Booking Web runs this too, so no Object.hasOwn (older Safari).
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const FUNNEL_EVENT_RULES: { [T in FunnelEventType]: Record<keyof FunnelEventProperties[T], Rule> } =
  {
    page_visit: {},
    room_viewed: {
      roomTypeId: { valid: (value) => typeof value === "string" && /^[\w-]{1,64}$/.test(value) },
    },
    rate_selected: { entry: oneOf(["room_card", "rooms_form"]) },
    step_viewed: { step: oneOf(FUNNEL_STEPS) },
    addons_step_passed: { extrasShown: flag, extrasChosen: flag },
    details_completed: {},
    complete_booking_clicked: { paymentMethod: method, mode: oneOf(["instant", "request"]) },
    payment_authorized: { paymentMethod: oneOf(["card"]) },
    booking_completed: {
      paymentMethod: method,
      outcome: oneOf(["confirmed", "requested", "awaiting_payment"]),
    },
    booking_error: {
      step: oneOf(FUNNEL_STEPS),
      reason: oneOf(FUNNEL_ERROR_REASONS),
      code: { ...oneOf(FUNNEL_ERROR_CODES), optional: true },
    },
  };

/** Session and event ids are random UUIDs: never anything a guest typed. */
export function isFunnelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/** The event's metadata when it carries exactly what its type allows, else null. */
export function parseFunnelEventMetadata(
  eventType: string,
  metadata: unknown,
): Record<string, unknown> | null {
  if (!own(FUNNEL_EVENT_RULES, eventType)) return null;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const rules: Record<string, Rule> = FUNNEL_EVENT_RULES[eventType as FunnelEventType];
  const { funnelVersion, funnelSequence, ...properties } = metadata as Record<string, unknown>;
  if (funnelVersion !== 1 || !Number.isSafeInteger(funnelSequence) || Number(funnelSequence) < 1)
    return null;
  if (Object.keys(properties).some((key) => !own(rules, key))) return null;
  for (const [key, rule] of Object.entries(rules)) {
    if (own(properties, key) ? !rule.valid(properties[key]) : !rule.optional) return null;
  }
  return { ...properties, funnelVersion, funnelSequence };
}
export type BookingFunnelEvent = {
  sessionId: string;
  sequence: number;
  stage: FunnelStage;
  paymentMethod?: FunnelPaymentMethod;
};
export type BookingConversionFunnel = {
  steps: {
    stage: FunnelStage;
    count: number;
    percentOfVisits: number | null;
    conversionPercent: number | null;
    previousCount: number;
  }[];
  paymentMethods: { method: FunnelPaymentMethod; count: number }[];
  biggestDrop: FunnelStage | null;
};
export type BookingConversionFunnelReadPort = {
  getConversionFunnel(input: {
    propertyId: string;
    windowStart: string;
    windowEnd: string;
  }): Promise<BookingConversionFunnel | null>;
};

/** Events are already property/time/traffic scoped by the target repository. */
export function buildBookingConversionFunnel(
  events: readonly BookingFunnelEvent[],
  addonsEnabled: boolean,
): BookingConversionFunnel {
  const stages = FUNNEL_STAGES.filter((stage) => addonsEnabled || stage !== "addons_step_passed");
  const prefix = stages.slice(0, stages.indexOf("complete_booking_clicked"));
  const sessions = new Map<
    string,
    {
      next: number;
      method?: FunnelPaymentMethod;
      authorized: boolean;
      completed: boolean;
      sequence: number;
    }
  >();
  const counts = new Map<FunnelStage, number>(stages.map((stage) => [stage, 0]));
  const methods = new Map<FunnelPaymentMethod, number>(
    FUNNEL_PAYMENT_METHODS.map((method) => [method, 0]),
  );
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (!event.sessionId || !Number.isSafeInteger(event.sequence) || event.sequence < 1) continue;
    let session = sessions.get(event.sessionId);
    if (!session) {
      session = { next: 0, authorized: false, completed: false, sequence: 0 };
      sessions.set(event.sessionId, session);
    }
    if (event.sequence <= session.sequence) continue;
    session.sequence = event.sequence;
    if (session.next < prefix.length) {
      if (event.stage !== prefix[session.next]) continue;
      counts.set(event.stage, (counts.get(event.stage) ?? 0) + 1);
      session.next++;
      continue;
    }
    if (session.completed) continue;
    if (
      event.stage === "complete_booking_clicked" &&
      event.paymentMethod &&
      FUNNEL_PAYMENT_METHODS.includes(event.paymentMethod)
    ) {
      if (session.method === event.paymentMethod) continue;
      if (session.method) {
        methods.set(session.method, methods.get(session.method)! - 1);
        if (session.authorized)
          counts.set("payment_authorized", counts.get("payment_authorized")! - 1);
      } else counts.set(event.stage, counts.get(event.stage)! + 1);
      session.method = event.paymentMethod;
      session.authorized = false;
      methods.set(session.method, methods.get(session.method)! + 1);
    } else if (event.paymentMethod === session.method && session.method) {
      if (
        event.stage === "payment_authorized" &&
        session.method === "card" &&
        !session.authorized
      ) {
        session.authorized = true;
        counts.set(event.stage, counts.get(event.stage)! + 1);
      } else if (
        event.stage === "booking_completed" &&
        (session.method !== "card" || session.authorized)
      ) {
        session.completed = true;
        counts.set(event.stage, counts.get(event.stage)! + 1);
      }
    }
  }
  const visits = counts.get("page_visit")!;
  const percent = (count: number, total: number) =>
    total ? Math.round((count / total) * 1000) / 10 : null;
  let biggestDrop: FunnelStage | null = null;
  let largestLoss = 0;
  const steps = stages.map((stage, index) => {
    const count = counts.get(stage)!;
    const previousCount =
      stage === "payment_authorized"
        ? methods.get("card")!
        : stage === "booking_completed"
          ? counts.get("payment_authorized")! +
            counts.get("complete_booking_clicked")! -
            methods.get("card")!
          : counts.get(stages[Math.max(0, index - 1)]!)!;
    const loss = previousCount ? 1 - count / previousCount : 0;
    if (index > 0 && loss > largestLoss) {
      largestLoss = loss;
      biggestDrop = stage;
    }
    return {
      stage,
      count,
      percentOfVisits: percent(count, visits),
      conversionPercent: percent(count, previousCount),
      previousCount,
    };
  });
  return {
    steps,
    paymentMethods: [...methods]
      .filter(([, count]) => count > 0)
      .map(([method, count]) => ({ method, count })),
    biggestDrop,
  };
}
