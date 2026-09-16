import {
  parseBookingGuestPolicyChoices,
  type BookingGuestPolicyChoices,
} from "./bookingGuestPolicy.js";
import type { PublicBookingQuote } from "./publicBookingQuote.js";

export type PublicQuoteGuestDisclosure = Readonly<{
  version: "public-quote-guest-disclosure.v1";
  quoteId: string;
  quoteEvidenceId: string;
  guestPolicyEvidenceId: string;
  issuedAt: string;
  expiresAt: string;
  checkedAt: string;
  propertyTimeZone: string;
  choices: BookingGuestPolicyChoices;
}>;
const iso = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const hash = (v: unknown) => typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);

/** Public presentation identity only; server acceptance re-reads all current owners. */
export function parsePublicQuoteGuestDisclosure(
  value: unknown,
  quote: PublicBookingQuote,
): PublicQuoteGuestDisclosure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = [
    "version",
    "quoteId",
    "quoteEvidenceId",
    "guestPolicyEvidenceId",
    "issuedAt",
    "expiresAt",
    "checkedAt",
    "propertyTimeZone",
    "choices",
  ];
  if (
    Object.keys(v).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(v, key)) ||
    v.version !== "public-quote-guest-disclosure.v1" ||
    v.quoteId !== quote.quoteId ||
    !hash(v.quoteEvidenceId) ||
    !hash(v.guestPolicyEvidenceId) ||
    v.issuedAt !== quote.issuedAt ||
    v.expiresAt !== quote.expiresAt ||
    !iso(v.checkedAt) ||
    v.checkedAt < quote.issuedAt ||
    v.checkedAt >= quote.expiresAt ||
    typeof v.propertyTimeZone !== "string" ||
    !v.propertyTimeZone.trim()
  )
    return null;
  const choices = parseBookingGuestPolicyChoices(v.choices);
  if (!choices) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: v.propertyTimeZone }).format();
  } catch {
    return null;
  }
  return structuredClone({ ...v, choices }) as PublicQuoteGuestDisclosure;
}
