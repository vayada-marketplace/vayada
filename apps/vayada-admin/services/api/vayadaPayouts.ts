import { apiClient } from "./client";

/** vayada Payment payouts (VAY-2442 P5): what Vayada owes each hotel for card payments it
 * collected, paid out by hand on Mondays for stays checked out by the Sunday before. Amounts are
 * minor units as strings, in the stay's currency. Live and test-mode money are separate. */
export type PayoutMode = "live" | "test";

export type PayoutHotel = {
  propertyId: string;
  name: string;
  currency: string;
  /** Owed for stays checked out by the cut-off, less payouts; negative when the hotel owes. */
  payableMinor: string;
  /** What to send now (whole rupiah for IDR); 0 when nothing is owed. */
  payNowMinor: string;
  /** Owed for stays checking out after the cut-off. */
  upcomingMinor: string;
  destination: PayoutDestination | null;
  /** Started (taken off the balance) but not marked sent yet: finish or cancel it. */
  sending: { id: string; amountMinor: string; startedAt: string } | null;
  lastPayout: { id: string; amountMinor: string; paidOn: string; reference: string } | null;
};

export type PayoutDestination = { id: string; accountLast4: string; countryCode: string };

export type PayoutList = { mode: PayoutMode; cutoff: string; hotels: PayoutHotel[] };

export type PayoutEntry = {
  id: string;
  kind:
    | "charge"
    | "refund"
    | "dispute"
    | "dispute_reversal"
    | "payout"
    | "payout_returned"
    | "adjustment";
  currency: string;
  grossMinor: string;
  feeMinor: string;
  netMinor: string;
  bookingReference: string | null;
  checkOut: string | null;
  occurredAt: string;
};

export type Payout = {
  id: string;
  currency: string;
  amountMinor: string;
  cutoff: string;
  accountLast4: string;
  startedAt: string;
  reference: string | null;
  paidOn: string | null;
  sentAt: string | null;
  returnedAt: string | null;
  returnReason: string | null;
};

export type PayoutHotelDetail = {
  mode: PayoutMode;
  cutoff: string;
  propertyId: string;
  name: string;
  balances: PayoutHotel[];
  destination: PayoutDestination | null;
  entries: PayoutEntry[];
  payouts: Payout[];
};

export type PayoutBankDetails = {
  destinationId: string;
  countryCode: string;
  accountHolder: string;
  accountNumber: string;
  bankName: string;
  bankCode?: string;
  branchCode?: string;
  bicSwift?: string;
  holderAddress?: string;
};

const BASE = "/api/finance/platform/vayada-payment/payouts";
const hotelPath = (propertyId: string) => `${BASE}/${encodeURIComponent(propertyId)}`;

export const vayadaPayoutsService = {
  list: (mode: PayoutMode) => apiClient.get<PayoutList>(`${BASE}?mode=${mode}`),
  detail: (propertyId: string, mode: PayoutMode) =>
    apiClient.get<PayoutHotelDetail>(`${hotelPath(propertyId)}?mode=${mode}`),
  /** Audited on the server: every look at a hotel's bank details is recorded. Refused when the
   * hotel's account isn't the one expected (it changed since the payout started). */
  revealBankDetails: (propertyId: string, destinationId: string) =>
    apiClient.post<PayoutBankDetails>(`${hotelPath(propertyId)}/destination/reveal`, {
      destinationId,
    }),
  /** Before any money moves: takes exactly what is owed off the hotel's balance. */
  start: (
    propertyId: string,
    input: {
      mode: PayoutMode;
      currency: string;
      cutoff: string;
      amountMinor: string;
      destinationId: string;
    },
  ) =>
    apiClient.post<{ payoutId: string }>(hotelPath(propertyId), {
      commandId: globalThis.crypto.randomUUID(),
      ...input,
    }),
  markSent: (propertyId: string, payoutId: string, input: { reference: string; paidOn: string }) =>
    apiClient.post<{ sent: true }>(
      `${hotelPath(propertyId)}/${encodeURIComponent(payoutId)}/sent`,
      input,
    ),
  /** Cancelled before sending, or sent back by the bank: the hotel is owed it again. */
  markReturned: (propertyId: string, payoutId: string, reason: string) =>
    apiClient.post<{ returned: true }>(
      `${hotelPath(propertyId)}/${encodeURIComponent(payoutId)}/returned`,
      { commandId: globalThis.crypto.randomUUID(), reason },
    ),
};

// Stripe's minor units: these currencies have none; IDR counts hundredths but banks pay whole rupiah.
const ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

/** "IDR 1,250,000", "EUR 12.50", "LKR −4,500.00": exact for any size (digits, never a float). */
export function formatMinor(minor: string, currency: string): string {
  const match = /^(-?)0*(\d*)$/.exec(minor.trim());
  if (!match) return `${currency} —`;
  const decimals = ZERO_DECIMAL.has(currency) ? 0 : 2;
  const digits = (match[2] || "0").padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = digits.slice(digits.length - decimals);
  const showFraction = decimals > 0 && !(currency === "IDR" && /^0+$/.test(fraction));
  const negative = match[1] === "-" && /[1-9]/.test(digits);
  return `${currency} ${negative ? "−" : ""}${whole}${showFraction ? `.${fraction}` : ""}`;
}

/** Whether an amount in minor units is above zero (strings, so any size). */
export function isPositive(minor: string): boolean {
  return /^0*[1-9]\d*$/.test(minor.trim());
}

/** Whether an amount in minor units is below zero. */
export function isNegative(minor: string): boolean {
  return /^-0*[1-9]\d*$/.test(minor.trim());
}

export const ENTRY_LABELS: Record<PayoutEntry["kind"], string> = {
  charge: "Card payment",
  refund: "Refund",
  dispute: "Dispute",
  dispute_reversal: "Dispute won",
  payout: "Payout",
  payout_returned: "Payout returned",
  adjustment: "Adjustment",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sun 8 Nov 2026" for a calendar date (YYYY-MM-DD), the same in every time zone and browser. */
export function formatDay(date: string, withWeekday = false): string {
  const day = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return date;
  const text = `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
  return withWeekday ? `${WEEKDAYS[day.getUTCDay()]} ${text}` : text;
}

/** Today's calendar date where the operator is, for "paid on". */
export function today(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
