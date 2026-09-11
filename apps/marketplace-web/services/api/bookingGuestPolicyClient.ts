import {
  BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES,
  parseBookingGuestPolicyChoices,
  parseBookingGuestPolicyHash,
  type BookingGuestPolicyChoices,
  type BookingGuestPolicyComposition,
  type BookingGuestPolicyRateDisclosure,
  type BookingGuestPolicySetupDraft,
  type UpsertBookingGuestPolicyRequest,
} from "@vayada/domain-booking";
import { targetApiClient } from "./targetClient";

type Scope = { organizationId: string; propertyId: string };
type Http = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
  post<T>(path: string, data?: unknown, options?: RequestInit): Promise<T>;
  put<T>(path: string, data?: unknown, options?: RequestInit): Promise<T>;
};
export type GuestPolicySetup = {
  revision: number;
  choices: BookingGuestPolicyChoices | BookingGuestPolicySetupDraft;
};

// The API validates complete domain evidence (including hashes). This browser
// boundary validates the scoped fields consumed by the editor, without Node crypto.
export function createBookingGuestPolicyClient(http: Http) {
  return {
    async load(scope: Scope, options?: RequestInit): Promise<GuestPolicySetup> {
      const value = await http.get<unknown>(path(scope), options);
      if (
        !record(value) ||
        !scoped(value, scope) ||
        value.contractVersion !== "booking-guest-policy.v1" ||
        JSON.stringify(value.supportedLanguages) !==
          JSON.stringify(BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES)
      )
        throw invalid();
      if (value.current !== null) {
        if (value.draft !== null) throw invalid();
        return revision(value.current, scope);
      }
      const draft = value.draft;
      if (
        !record(draft) ||
        draft.defaultGuestLanguage !== null ||
        draft.childrenEnabled !== null ||
        draft.adultAgeThreshold !== null ||
        draft.phoneRequired !== true ||
        draft.arrivalTimeEnabled !== false ||
        draft.specialRequestsEnabled !== true
      )
        throw invalid();
      const parsed = parseBookingGuestPolicyChoices({
        ...draft,
        defaultGuestLanguage: "en",
        childrenEnabled: false,
        checkInTime: draft.checkInTime ?? "15:00",
        checkOutTime: draft.checkOutTime ?? "11:00",
      });
      if (!parsed) throw invalid();
      // Validation placeholders above are never returned as selected answers.
      return { revision: 0, choices: draft as BookingGuestPolicySetupDraft };
    },
    async preview(
      scope: Scope,
      choices: BookingGuestPolicyChoices,
      options?: RequestInit,
    ): Promise<BookingGuestPolicyComposition> {
      const parsed = parseBookingGuestPolicyChoices(choices);
      if (!parsed) throw invalid();
      const value = await http.post<unknown>(
        `${path(scope)}/preview`,
        { choices: parsed },
        options,
      );
      if (!record(value)) throw invalid();
      if (value.outcome === "blocked") {
        if (
          !scoped(value, scope) ||
          !parseBookingGuestPolicyHash(value.sourceFingerprint) ||
          !Array.isArray(value.blockers) ||
          value.blockers.length === 0 ||
          value.blockers.some((blocker) => !record(blocker) || typeof blocker.code !== "string")
        )
          throw invalid();
      } else if (value.outcome === "ready") {
        const bundle = readBundle(value.bundle, scope);
        if (!sameChoices(bundle.choices, parsed)) throw invalid();
      } else throw invalid();
      return value as BookingGuestPolicyComposition;
    },
    async save(
      scope: Scope,
      request: UpsertBookingGuestPolicyRequest,
      reviewed: Scope & {
        choices: BookingGuestPolicyChoices;
        sourceFingerprint: string;
        bundleHash: string;
      },
    ): Promise<GuestPolicySetup> {
      const choices = parseBookingGuestPolicyChoices(request.choices);
      if (
        !choices ||
        !Number.isSafeInteger(request.expectedRevision) ||
        request.expectedRevision < 0 ||
        !parseBookingGuestPolicyHash(request.expectedSourceFingerprint) ||
        !parseBookingGuestPolicyHash(reviewed.bundleHash) ||
        !scoped(reviewed, scope) ||
        !sameChoices(reviewed.choices, choices) ||
        reviewed.sourceFingerprint !== request.expectedSourceFingerprint ||
        !request.confirmPolicyBundle
      )
        throw invalid();
      const body = { ...request, choices };
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify({ scope, body })),
      );
      const key = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const value = await http.put<unknown>(path(scope), body, {
        headers: { "Idempotency-Key": `guest-policy:${scope.propertyId}:${key.slice(0, 40)}` },
      });
      if (
        !record(value) ||
        !["created", "updated", "idempotent_replay"].includes(String(value.outcome))
      )
        throw invalid();
      const saved = revision(value.revision, scope);
      const bundle = readBundle((value.revision as Record<string, unknown>).bundle, scope);
      if (
        saved.revision !== request.expectedRevision + 1 ||
        !sameChoices(saved.choices as BookingGuestPolicyChoices, choices) ||
        bundle.bundleHash !== reviewed.bundleHash ||
        bundle.sourceFingerprint !== request.expectedSourceFingerprint
      )
        throw invalid();
      return saved;
    },
  };
}
export const bookingGuestPolicyClient = createBookingGuestPolicyClient(targetApiClient);

function revision(value: unknown, scope: Scope): GuestPolicySetup {
  if (
    !record(value) ||
    !scoped(value, scope) ||
    value.contractVersion !== "booking-guest-policy.v1" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1
  )
    throw invalid();
  const bundle = readBundle(value.bundle, scope);
  return { revision: value.revision as number, choices: bundle.choices };
}
function readBundle(value: unknown, scope: Scope) {
  if (
    !record(value) ||
    !scoped(value, scope) ||
    value.contractVersion !== "booking-guest-policy.v1" ||
    !parseBookingGuestPolicyHash(value.sourceFingerprint) ||
    !parseBookingGuestPolicyHash(value.bundleHash) ||
    typeof value.pricingCurrency !== "string" ||
    !/^[A-Z]{3}$/.test(value.pricingCurrency) ||
    typeof value.propertyTimeZone !== "string" ||
    !value.propertyTimeZone ||
    !Array.isArray(value.rates) ||
    value.rates.length === 0 ||
    value.rates.some(
      (rate) =>
        !validRate(rate) ||
        rate.flexible.cutoff.timeZone !== value.propertyTimeZone ||
        (rate.additionalGuest !== null && rate.additionalGuest.currency !== value.pricingCurrency),
    )
  )
    throw invalid();
  const choices = parseBookingGuestPolicyChoices(value.choices);
  if (!choices) throw invalid();
  return {
    ...value,
    choices,
    bundleHash: value.bundleHash as string,
    sourceFingerprint: value.sourceFingerprint as string,
  };
}
function validRate(value: unknown): value is BookingGuestPolicyRateDisclosure {
  if (!record(value) || typeof value.roomTypeId !== "string" || !record(value.flexible))
    return false;
  const rate = value.flexible;
  if (
    !Number.isSafeInteger(rate.freeCancellationDeadlineDays) ||
    Number(rate.freeCancellationDeadlineDays) < 0 ||
    !record(rate.cutoff) ||
    typeof rate.cutoff.localTime !== "string" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(rate.cutoff.localTime) ||
    typeof rate.cutoff.timeZone !== "string" ||
    rate.afterDeadlinePenalty !== "full_booking_amount" ||
    rate.noShowPenalty !== "full_booking_amount"
  )
    return false;
  if (
    value.nonRefundable !== null &&
    (!record(value.nonRefundable) ||
      value.nonRefundable.refundPolicy !== "no_refund" ||
      value.nonRefundable.noShowPenalty !== "full_booking_amount" ||
      value.nonRefundable.paymentTiming !== "prepay_full")
  )
    return false;
  if (
    value.additionalGuest !== null &&
    (!record(value.additionalGuest) ||
      !Number.isSafeInteger(value.additionalGuest.includedGuestsPerRoom) ||
      Number(value.additionalGuest.includedGuestsPerRoom) < 1 ||
      typeof value.additionalGuest.amountDecimal !== "string" ||
      !/^\d+(\.\d+)?$/.test(value.additionalGuest.amountDecimal) ||
      typeof value.additionalGuest.currency !== "string" ||
      !Array.isArray(value.additionalGuest.countedGuestTypes) ||
      !['["adult"]', '["adult","child"]'].includes(
        JSON.stringify(value.additionalGuest.countedGuestTypes),
      ))
  )
    return false;
  return true;
}
function sameChoices(a: BookingGuestPolicyChoices, b: BookingGuestPolicyChoices) {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([key, value]) => b[key as keyof BookingGuestPolicyChoices] === value)
  );
}
function scoped(value: Record<string, unknown>, scope: Scope) {
  return value.organizationId === scope.organizationId && value.propertyId === scope.propertyId;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function path(scope: Scope) {
  return `/api/booking/properties/${encodeURIComponent(scope.propertyId)}/booking-guest-policy`;
}
function invalid() {
  return new Error(
    "Guest policy evidence is invalid or belongs to another hotel. Refresh and try again.",
  );
}
