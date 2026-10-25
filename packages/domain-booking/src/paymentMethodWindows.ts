/**
 * VAY-2348: a hotel can offer a payment method only to guests who book a certain time before
 * arrival. Lead times count to the hotel's check-in time in its own time zone; a day is 24 hours.
 * Shared by the API (quote, booking, checkout settings) and Booking Admin (settings, gap warning).
 */

/** The methods a booking window can limit. PayPal keeps only its own payment window. */
export const WINDOWED_PAYMENT_METHODS = ["card", "pay_at_property", "bank_transfer"] as const;
export type WindowedPaymentMethod = (typeof WINDOWED_PAYMENT_METHODS)[number];

/** Bank transfer's fixed payment deadline: the transfer must arrive within this many hours of
 * booking (VAY-2139), so check-in must be at least this far away (VAY-2145). */
export const BANK_TRANSFER_PAYMENT_DEADLINE_HOURS = 48;

/** "Only if booked at least [amount] days before arrival" or "only if booked within [amount]
 * hours/days before arrival". No window means the method has no limit. */
export type PaymentMethodBookingWindow =
  | Readonly<{ kind: "at_least"; amount: number; unit: "days" }>
  | Readonly<{ kind: "within"; amount: number; unit: "hours" | "days" }>;
export type PaymentMethodBookingWindows = Partial<
  Record<WindowedPaymentMethod, PaymentMethodBookingWindow>
>;

/** Up to a year before arrival. */
const MAX_WINDOW_HOURS = 365 * 24;

export function isWindowedPaymentMethod(method: unknown): method is WindowedPaymentMethod {
  return (WINDOWED_PAYMENT_METHODS as readonly unknown[]).includes(method);
}

export function paymentWindowHours(window: PaymentMethodBookingWindow): number {
  return window.amount * (window.unit === "days" ? 24 : 1);
}

export type PaymentMethodWindowsProblem =
  | "invalid"
  /** Bank transfer: "at least" needs 3 days or more, "within" more than 48 hours (VAY-2348 D7). */
  | "bank_transfer_window_too_short";

/**
 * Hotel settings as `{ method: window | null }`; a missing or null method has no limit. Strict:
 * unknown methods or fields are refused.
 */
export function parsePaymentMethodBookingWindows(
  value: unknown,
):
  | { ok: true; windows: PaymentMethodBookingWindows }
  | { ok: false; problem: PaymentMethodWindowsProblem; method?: string } {
  if (!isRecord(value)) return { ok: false, problem: "invalid" };
  const windows: PaymentMethodBookingWindows = {};
  for (const [method, raw] of Object.entries(value)) {
    if (!isWindowedPaymentMethod(method)) return { ok: false, problem: "invalid", method };
    if (raw === null) continue;
    const window = parseWindow(raw);
    if (!window) return { ok: false, problem: "invalid", method };
    if (method === "bank_transfer" && !bankTransferWindowFits(window))
      return { ok: false, problem: "bank_transfer_window_too_short", method };
    windows[method] = window;
  }
  return { ok: true, windows };
}

/**
 * Whether a guest booking `leadMs` before check-in may pay this way under `window`. Bank
 * transfer's own 48-hour rule is checked separately, where its payment terms are read.
 */
export function paymentWindowAllows(
  window: PaymentMethodBookingWindow | null | undefined,
  leadMs: number,
): boolean {
  if (!window) return true;
  const limit = paymentWindowHours(window) * 3_600_000;
  return window.kind === "at_least" ? leadMs >= limit : leadMs <= limit;
}

/** Lead times in hours before check-in; `toHours` null means "and further out". */
export type PaymentMethodGap = Readonly<{ fromHours: number; toHours: number | null }>;

/**
 * The lead times at which none of `methods` can be used, for Booking Admin's warning ("guests
 * booking 3-6 days before arrival have no payment option"). Bank transfer always needs 48 hours.
 */
export function paymentMethodGaps(
  methods: readonly WindowedPaymentMethod[],
  windows: PaymentMethodBookingWindows,
): PaymentMethodGap[] {
  const ranges = methods
    .map((method) => {
      const window = windows[method];
      let from = method === "bank_transfer" ? BANK_TRANSFER_PAYMENT_DEADLINE_HOURS : 0;
      let to = Number.POSITIVE_INFINITY;
      if (window?.kind === "at_least") from = Math.max(from, paymentWindowHours(window));
      if (window?.kind === "within") to = paymentWindowHours(window);
      return { from, to };
    })
    .filter(({ from, to }) => from <= to)
    .sort((a, b) => a.from - b.from);
  const gaps: PaymentMethodGap[] = [];
  let covered = 0;
  for (const { from, to } of ranges) {
    if (from > covered) gaps.push({ fromHours: covered, toHours: from });
    covered = Math.max(covered, to);
  }
  if (covered !== Number.POSITIVE_INFINITY) gaps.push({ fromHours: covered, toHours: null });
  return gaps;
}

function parseWindow(value: unknown): PaymentMethodBookingWindow | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  const { kind, amount, unit } = value;
  if (keys !== "amount,kind,unit" || !Number.isInteger(amount) || (amount as number) < 1)
    return null;
  const window =
    kind === "at_least" && unit === "days"
      ? ({ kind, amount, unit } as PaymentMethodBookingWindow)
      : kind === "within" && (unit === "hours" || unit === "days")
        ? ({ kind, amount, unit } as PaymentMethodBookingWindow)
        : null;
  return window && paymentWindowHours(window) <= MAX_WINDOW_HOURS ? window : null;
}

function bankTransferWindowFits(window: PaymentMethodBookingWindow): boolean {
  return window.kind === "at_least"
    ? window.amount >= 3
    : paymentWindowHours(window) > BANK_TRANSFER_PAYMENT_DEADLINE_HOURS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
