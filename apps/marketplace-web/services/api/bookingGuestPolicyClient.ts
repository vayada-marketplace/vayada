import {
  BOOKING_GUEST_POLICY_SUPPORTED_LANGUAGES,
  parseBookingGuestPolicyChoices,
  parseBookingGuestPolicyHash,
  type BookingGuestPolicyChoices,
  type BookingGuestPolicyComposition,
  type BookingGuestPolicyRateDisclosure,
  type BookingGuestPolicySourceBinding,
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
          !validSources(value.sourceBindings) ||
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
        new TextEncoder().encode(
          JSON.stringify({ scope, body }, (_key, value) =>
            record(value)
              ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
              : value,
          ),
        ),
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
    typeof value.pricingSourceFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.pricingSourceFingerprint) ||
    !positiveRevision(value.mandatoryChargeConfirmationRevision) ||
    !validSources(value.sourceBindings) ||
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
  const sources = value.sourceBindings;
  for (const entityType of [
    "property_profile",
    "pms_property_pricing_currency.v1",
    "pms_optional_pricing_aggregate.v1",
    "pms_mandatory_charge_confirmation.v1",
  ]) {
    const matches = sources.filter((source) => source.entityType === entityType);
    if (
      matches.length !== 1 ||
      matches[0].entityId !== scope.propertyId ||
      (entityType === "pms_mandatory_charge_confirmation.v1" &&
        matches[0].revision !== String(value.mandatoryChargeConfirmationRevision))
    )
      throw invalid();
  }
  const hasSource = (expected: BookingGuestPolicySourceBinding) =>
    sources.some(
      (source) =>
        source.ownerDomain === expected.ownerDomain &&
        source.entityType === expected.entityType &&
        source.entityId === expected.entityId &&
        source.revision === expected.revision,
    );
  if (
    sources.filter((source) => source.entityType === "pms_room_facts.v1").length !==
      value.rates.length ||
    sources.filter((source) => source.entityType === "pms_flexible_rate_plan.v1").length !==
      value.rates.length ||
    value.rates.some(
      (rate: BookingGuestPolicyRateDisclosure) =>
        !hasSource({
          ownerDomain: "pms",
          entityType: "pms_room_facts.v1",
          entityId: rate.roomTypeId,
          revision: String(rate.roomFactsRevision),
        }) ||
        !hasSource(rate.flexible.source) ||
        (rate.nonRefundable !== null && !hasSource(rate.nonRefundable.source.source)) ||
        (rate.additionalGuest !== null && !hasSource(rate.additionalGuest.source.source)),
    )
  )
    throw invalid();
  return {
    ...value,
    choices,
    bundleHash: value.bundleHash as string,
    sourceFingerprint: value.sourceFingerprint as string,
  };
}
function validRate(value: unknown): value is BookingGuestPolicyRateDisclosure {
  if (
    !record(value) ||
    typeof value.roomTypeId !== "string" ||
    !positiveRevision(value.roomFactsRevision) ||
    !record(value.flexible)
  )
    return false;
  const rate = value.flexible;
  if (
    !validSource(rate.source, "pms_flexible_rate_plan.v1") ||
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
      !validRecurringSource(value.nonRefundable.source) ||
      value.nonRefundable.refundPolicy !== "no_refund" ||
      value.nonRefundable.noShowPenalty !== "full_booking_amount" ||
      value.nonRefundable.paymentTiming !== "prepay_full")
  )
    return false;
  if (
    value.additionalGuest !== null &&
    (!record(value.additionalGuest) ||
      !validRecurringSource(value.additionalGuest.source) ||
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
function positiveRevision(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 2_147_483_647;
}
function validSource(value: unknown, entityType?: string): boolean {
  if (
    !record(value) ||
    typeof value.entityId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.entityId,
    ) ||
    typeof value.revision !== "string" ||
    (entityType && value.entityType !== entityType)
  )
    return false;
  if (value.ownerDomain === "hotel_catalog") {
    return value.entityType === "property_profile" && /^profile:[1-9][0-9]*$/.test(value.revision);
  }
  return (
    value.ownerDomain === "pms" &&
    [
      "pms_property_pricing_currency.v1",
      "pms_optional_pricing_aggregate.v1",
      "pms_room_facts.v1",
      "pms_flexible_rate_plan.v1",
      "pms_recurring_pricing_rule.v1",
      "pms_mandatory_charge_confirmation.v1",
    ].includes(String(value.entityType)) &&
    /^(0|[1-9][0-9]*)$/.test(value.revision) &&
    Number(value.revision) <= 2_147_483_647
  );
}
function validSources(value: unknown): value is BookingGuestPolicySourceBinding[] {
  return Array.isArray(value) && value.every((source) => validSource(source));
}
function validRecurringSource(value: unknown) {
  return (
    record(value) &&
    validSource(value.source, "pms_recurring_pricing_rule.v1") &&
    positiveRevision(value.validationRevision) &&
    positiveRevision(value.materializationRevision)
  );
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
