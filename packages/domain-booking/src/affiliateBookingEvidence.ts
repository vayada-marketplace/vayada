/** VAY-1505: structural validation, not attribution or evidence-authority approval. */
export const AFFILIATE_BOOKING_EVIDENCE_VERSION = "affiliate-booking-evidence.v1";

type EvidenceMoney = {
  amount: string;
  currency: string;
  basis: "gross_booking" | "accommodation" | "tax" | "fee" | "other";
};

export type AffiliateBookingEvidenceObservation = {
  contractVersion: typeof AFFILIATE_BOOKING_EVIDENCE_VERSION;
  sourceEventKey: string;
  sourceRevision: string | null;
  supersedesEventKey: string | null;
  sourceOccurredAt: string | null;
  retrievedAt: string | null;
  booking: {
    externalPropertyId: string;
    reservationId: string;
    reservationItemId: string | null;
  };
  facts: {
    reservationStatus?: "requested" | "confirmed" | "cancelled" | "deleted" | "unknown";
    stayStatus?: "not_started" | "checked_in" | "completed" | "no_show" | "unknown";
    scheduledArrival?: string;
    scheduledDeparture?: string;
    actualDepartureAt?: string | null;
    bookingAmount?: EvidenceMoney | null;
    refundTotal?: EvidenceMoney | null;
    referralCandidates?: { reference: string; method: string }[];
  };
  provenance: {
    kind:
      | "authenticated_source_read"
      | "authenticated_source_event"
      | "authorized_hotel_confirmation"
      | "authorized_import";
    evidenceReference: string;
    originActor: "hotel_operator" | "source_system" | "vayada_command" | "unknown";
    causedByVayadaCommandId: string | null;
  };
};

type Check = (value: unknown) => boolean;
const text =
  (max: number): Check =>
  (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
const id = text(256);
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const oneOf =
  (...values: string[]): Check =>
  (value) =>
    typeof value === "string" && values.includes(value);

function record(
  value: unknown,
  required: Record<string, Check>,
  optional: Record<string, Check> = {},
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  if (!Object.keys(required).every((key) => keys.includes(key))) return false;
  return keys.every((key) => {
    if (typeof key !== "string") return false;
    const check = Object.hasOwn(required, key)
      ? required[key]
      : Object.hasOwn(optional, key)
        ? optional[key]
        : undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return (
      !!check && "value" in descriptor && descriptor.enumerable === true && check(descriptor.value)
    );
  });
}

const date: Check = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const utc: Check = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)
  )
    return false;
  const parsed = new Date(value);
  const canonical = value.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`,
  );
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === canonical;
};
const money: Check = (value) =>
  record(value, {
    amount: (amount) =>
      typeof amount === "string" && /^(0|[1-9]\d{0,17})(\.\d{1,6})?$/.test(amount),
    currency: (currency) => typeof currency === "string" && /^[A-Z]{3}$/.test(currency),
    basis: oneOf("gross_booking", "accommodation", "tax", "fee", "other"),
  });
const candidates: Check = (value) => {
  if (!Array.isArray(value) || value.length > 32) return false;
  if (Reflect.ownKeys(value).length !== value.length + 1) return false;
  return Array.from({ length: value.length }, (_, index) => {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    return (
      entry && "value" in entry && record(entry.value, { reference: text(512), method: text(64) })
    );
  }).every(Boolean);
};

/** Accept decoded JSON only. Returned data is detached; omission is never filled in. */
export function parseAffiliateBookingEvidence(
  input: unknown,
): AffiliateBookingEvidenceObservation | null {
  if (
    !record(input, {
      contractVersion: oneOf(AFFILIATE_BOOKING_EVIDENCE_VERSION),
      sourceEventKey: id,
      sourceRevision: nullable(id),
      supersedesEventKey: nullable(id),
      sourceOccurredAt: nullable(utc),
      retrievedAt: nullable(utc),
      booking: (value) =>
        record(value, {
          externalPropertyId: id,
          reservationId: id,
          reservationItemId: nullable(id),
        }),
      facts: (value) =>
        record(
          value,
          {},
          {
            reservationStatus: oneOf("requested", "confirmed", "cancelled", "deleted", "unknown"),
            stayStatus: oneOf("not_started", "checked_in", "completed", "no_show", "unknown"),
            scheduledArrival: date,
            scheduledDeparture: date,
            actualDepartureAt: nullable(utc),
            bookingAmount: nullable(money),
            refundTotal: nullable(money),
            referralCandidates: candidates,
          },
        ),
      provenance: (value) =>
        record(value, {
          kind: oneOf(
            "authenticated_source_read",
            "authenticated_source_event",
            "authorized_hotel_confirmation",
            "authorized_import",
          ),
          evidenceReference: id,
          originActor: oneOf("hotel_operator", "source_system", "vayada_command", "unknown"),
          causedByVayadaCommandId: nullable(id),
        }),
    })
  )
    return null;
  return structuredClone(input) as AffiliateBookingEvidenceObservation;
}

export type AffiliateEvidenceBinding = {
  connectionId: string;
  organizationId: string;
  propertyId: string;
  externalPropertyId: string;
  state: "active" | "revoked";
};

/**
 * Both arguments after observation must come from authorized server-owned reads.
 * This checks binding only: it cannot authenticate a webhook or certify its facts.
 * Re-resolve access before queued processing; never cache a successful check as a grant.
 */
export function matchesAffiliateEvidenceBinding(
  observation: AffiliateBookingEvidenceObservation,
  binding: AffiliateEvidenceBinding,
  evidence: (Omit<AffiliateEvidenceBinding, "state"> & { evidenceReference: string }) | null,
): boolean {
  return (
    binding.state === "active" &&
    [
      binding.connectionId,
      binding.organizationId,
      binding.propertyId,
      binding.externalPropertyId,
    ].every(id) &&
    observation.booking.externalPropertyId === binding.externalPropertyId &&
    evidence !== null &&
    evidence.connectionId === binding.connectionId &&
    evidence.organizationId === binding.organizationId &&
    evidence.propertyId === binding.propertyId &&
    evidence.externalPropertyId === binding.externalPropertyId &&
    evidence.evidenceReference === observation.provenance.evidenceReference
  );
}
