import type {
  PayoutStatementLine,
  PayoutStatementPayout,
} from "@/services/api/financePayoutStatementClient";

type T = (key: string, params?: Record<string, string | number>) => string;

// Stripe's minor units: these currencies have none; IDR counts hundredths but banks pay whole
// rupiah. The same rules as Vayada Admin's payouts page, so both show the same figures.
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

/** "1,250,000", "12.50", "−4,500.00" (with `plus`, "+1,750,000"): exact for any size. */
export function formatDigits(minor: string, currency: string, plus = false): string {
  const match = /^(-?)0*(\d*)$/.exec(minor.trim());
  if (!match) return "—";
  const decimals = ZERO_DECIMAL.has(currency) ? 0 : 2;
  const digits = (match[2] || "0").padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = digits.slice(digits.length - decimals);
  const showFraction = decimals > 0 && !(currency === "IDR" && /^0+$/.test(fraction));
  const nonZero = /[1-9]/.test(digits);
  const sign = match[1] === "-" && nonZero ? "−" : plus && nonZero ? "+" : "";
  return `${sign}${whole}${showFraction ? `.${fraction}` : ""}`;
}

/** "IDR 1,250,000", "EUR 12.50", "LKR −4,500.00", as Vayada Admin shows them. */
export function formatMinor(minor: string, currency: string): string {
  return `${currency} ${formatDigits(minor, currency)}`;
}

export const isNegative = (minor: string) => /^-0*[1-9]\d*$/.test(minor.trim());
export const isPositive = (minor: string) => /^0*[1-9]\d*$/.test(minor.trim());
const negate = (minor: string) => (minor.startsWith("-") ? minor.slice(1) : `-${minor}`);

/** "Mon 30 Nov" for a calendar date (YYYY-MM-DD) in every time zone; the year only when it isn't
 * this year. English reads day before month, as in the rest of Booking Admin's payments. */
export function formatPayoutDay(date: string, locale: string, today = new Date()): string {
  const day = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return date;
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(day.getUTCFullYear() === today.getUTCFullYear() ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(day);
}

export const maskedAccount = (last4: string) => `•••• ${last4}`;

export type StatementFilter = "all" | "card" | "deductions";

/** Card payments, or what took money off them (refunds, disputes, dispute fees, corrections). */
export function filterLines(lines: PayoutStatementLine[], filter: StatementFilter) {
  if (filter === "card") return lines.filter((line) => line.kind === "charge");
  if (filter === "deductions")
    return lines.filter(
      (line) =>
        line.kind === "refund" ||
        line.kind === "dispute" ||
        line.kind === "dispute_fee" ||
        (line.kind === "adjustment" && isNegative(line.netMinor)),
    );
  return lines;
}

const payoutOf = (line: PayoutStatementLine, payouts: PayoutStatementPayout[]) =>
  line.payoutId ? payouts.find((payout) => payout.id === line.payoutId) : undefined;

/** The line's name: a payout that came back was either cancelled before sending or returned by
 * the bank. */
export function lineLabel(line: PayoutStatementLine, payouts: PayoutStatementPayout[], t: T) {
  if (line.kind === "payout_returned" && payoutOf(line, payouts)?.status === "cancelled")
    return t("settings.payouts.kind.payout_cancelled");
  return t(`settings.payouts.kind.${line.kind}`);
}

/** Why the line adds or takes what it does, in the hotel's words; null when the name says it. */
export function lineNote(
  line: PayoutStatementLine,
  payouts: PayoutStatementPayout[],
  t: T,
  locale: string,
): string | null {
  const money = (minor: string) => formatMinor(minor, line.currency);
  switch (line.kind) {
    case "charge":
      if (!line.fees) return null;
      return isPositive(line.fees.planMinor)
        ? t("settings.payouts.note.chargeFees", {
            plan: money(line.fees.planMinor),
            percent: line.fees.vayadaPercent,
            vayada: money(line.fees.vayadaMinor),
          })
        : t("settings.payouts.note.chargeFeesVayadaOnly", {
            percent: line.fees.vayadaPercent,
            vayada: money(line.fees.vayadaMinor),
          });
    case "refund":
      if (!isNegative(line.grossMinor)) return t("settings.payouts.note.refundCovered");
      return t(
        isNegative(line.feeMinor)
          ? "settings.payouts.note.refund"
          : "settings.payouts.note.refundNoFee",
        { amount: money(negate(line.grossMinor)) },
      );
    case "dispute":
      return isNegative(line.grossMinor)
        ? t("settings.payouts.note.dispute")
        : t("settings.payouts.note.disputeNothingTaken");
    case "dispute_reversal":
      return t("settings.payouts.note.disputeWon");
    case "dispute_fee":
      return t("settings.payouts.note.disputeFee");
    case "dispute_fee_returned":
      return t("settings.payouts.note.disputeFeeReturned");
    case "payout_returned": {
      const payout = payoutOf(line, payouts);
      if (!payout) return t("settings.payouts.note.payoutReturnedUnknown");
      return payout.status === "cancelled"
        ? t("settings.payouts.note.payoutCancelled", {
            date: formatPayoutDay(payout.startedOn, locale),
          })
        : t("settings.payouts.note.payoutReturned", {
            date: formatPayoutDay(payout.paidOn ?? payout.startedOn, locale),
          });
    }
    case "adjustment":
      return t("settings.payouts.note.adjustment");
    default:
      return null;
  }
}

/** The line's three figures as the statement shows them: the amount (blank for payouts), what fees
 * took (shown below zero; a fee that came back shows above) and what the hotel gets. Card payments
 * read as plain figures; everything else carries its sign. */
export function lineFigures(line: PayoutStatementLine) {
  const payoutLine = line.kind === "payout" || line.kind === "payout_returned";
  const signed = line.kind !== "charge";
  return {
    amount:
      payoutLine || line.grossMinor.replace(/^-?0*/, "") === ""
        ? ""
        : formatDigits(line.grossMinor, line.currency, signed),
    fees:
      line.feeMinor.replace(/^-?0*/, "") === ""
        ? ""
        : formatDigits(negate(line.feeMinor), line.currency, true),
    net: formatDigits(line.netMinor, line.currency, signed),
    tone: isNegative(line.netMinor)
      ? ("negative" as const)
      : signed && isPositive(line.netMinor)
        ? ("positive" as const)
        : ("plain" as const),
  };
}
