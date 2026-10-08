import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  createPmsMandatoryChargePricingSourceSnapshot,
  parseConfirmMandatoryChargesIncludedResult,
  parsePmsMandatoryChargeConfirmationReadResult,
  parsePmsPricingCurrencyCapabilities,
  parsePmsPricingSourceSnapshot,
  parsePmsRecurringPricingBookingEvidence,
  parsePropertyPricingCurrencyCommandResult,
  parseRoomTypeFactsSnapshot,
  type PmsPricingSourceSnapshot,
  type PmsRecurringPricingBookingEvidence,
  type RoomTypeFactsSnapshot,
} from "@vayada/domain-pms";
import { createReplacementPricingClient } from "@vayada/product-onboarding/replacementPricingClient";

import { ApiErrorResponse } from "./client";
import { targetApiClient } from "./targetClient";

export type OnboardingPricingHttpClient = {
  get<T>(endpoint: string, options?: RequestInit): Promise<T>;
  put<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
  post<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
};

/** Live PMS owner state the onboarding pricing step needs besides the pricing-v2 publication. */
export type OnboardingPricingOwners = {
  /** Supported currency codes; the capabilities contract requires them sorted. */
  currencies: readonly string[];
  /** Active room types with their facts revision, in name order. */
  rooms: readonly RoomTypeFactsSnapshot[];
  pricing: PmsPricingSourceSnapshot | null;
  recurringPricing: PmsRecurringPricingBookingEvidence | null;
  confirmationRevision: number;
  /** The final-price confirmation matches the current pricing source. */
  confirmationCurrent: boolean;
};

export class PricingOwnerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly requiresRefresh: boolean,
  ) {
    super(message);
    this.name = "PricingOwnerError";
  }
}

const messages: Record<string, string> = {
  unsupported_pricing_currency: "That currency is not supported end to end yet.",
  pricing_currency_unchanged: "The pricing currency is already saved.",
  pricing_currency_change_blocked:
    "The currency is already used by pricing, payments, bookings, or publication. Keep the current currency.",
  pricing_currency_revision_conflict: "The pricing currency changed in another session.",
  pricing_source_not_configured: "Save the hotel currency before confirming final prices.",
  pricing_source_conflict: "Prices changed before the final-price confirmation was recorded.",
  confirmation_revision_conflict: "The final-price confirmation changed in another session.",
  command_in_progress: "This save is still processing. Retry in a moment.",
  idempotency_key_conflict: "This save was reused for different input. Reload the latest pricing.",
  setup_scope_unavailable: "Pricing access is no longer available for this hotel.",
};

export function createOnboardingPricingClient(http: OnboardingPricingHttpClient) {
  const path = (propertyId: string, suffix: string) =>
    `/api/pms/properties/${encodeURIComponent(propertyId)}/${suffix}`;

  async function load(
    organizationId: string,
    propertyId: string,
    options?: RequestInit,
  ): Promise<OnboardingPricingOwners> {
    const [capabilitiesValue, roomsValue, pricingValue, recurringValue, confirmationValue] =
      await Promise.all([
        http.get<unknown>(path(propertyId, "pricing-source/currency-capabilities"), options),
        http.get<unknown>(
          `/api/pms/setup/properties/${encodeURIComponent(propertyId)}/room-types`,
          options,
        ),
        optionalGet(http, path(propertyId, "pricing-source"), options),
        optionalGet(http, path(propertyId, "pricing-source/recurring-booking-evidence"), options),
        confirmationGet(http, organizationId, propertyId, options),
      ]);
    const capabilities = parsePmsPricingCurrencyCapabilities(capabilitiesValue);
    const rooms = parseRooms(roomsValue, propertyId.toLowerCase());
    const pricing = pricingValue === null ? null : parsePmsPricingSourceSnapshot(pricingValue);
    const recurringPricing =
      recurringValue === null ? null : parsePmsRecurringPricingBookingEvidence(recurringValue);
    if (
      !capabilities ||
      !rooms ||
      (pricingValue !== null && pricing?.propertyId !== propertyId.toLowerCase()) ||
      (recurringValue !== null && recurringPricing?.propertyId !== propertyId.toLowerCase()) ||
      (pricing === null) !== (recurringPricing === null)
    ) {
      throw invalidOwnerContract("pricing workspace");
    }
    const fingerprint =
      pricing && recurringPricing
        ? await sourceFingerprint(rooms, pricing, recurringPricing)
        : null;
    return {
      currencies: capabilities.supportedCurrencies.map(({ code }) => code),
      rooms,
      pricing,
      recurringPricing,
      confirmationRevision: confirmationValue?.confirmationRevision ?? 0,
      confirmationCurrent:
        fingerprint !== null && confirmationValue?.pricingSourceFingerprint === fingerprint,
    };
  }

  return {
    load,

    /** Saves the hotel's one pricing currency through the PMS currency route. */
    async saveCurrency(
      organizationId: string,
      propertyId: string,
      currency: string,
      owners: OnboardingPricingOwners,
    ): Promise<OnboardingPricingOwners> {
      if (!owners.currencies.includes(currency)) {
        throw new PricingOwnerError(messages.unsupported_pricing_currency!, "unsupported", false);
      }
      const body = {
        expectedPricingCurrencyRevision:
          owners.pricing?.pricingCurrency.pricingCurrencyRevision ?? 0,
        currency,
      };
      const value = await ownerPut(
        http,
        path(propertyId, "pricing-source/currency"),
        body,
        await commandKey("pricing-currency", propertyId, body),
        "currency",
      );
      const result = parsePropertyPricingCurrencyCommandResult({ ok: true, response: value });
      if (
        !result?.ok ||
        result.response.pricingCurrency.propertyId !== propertyId.toLowerCase() ||
        result.response.pricingCurrency.currency !== currency
      ) {
        throw invalidOwnerContract("pricing currency receipt");
      }
      return load(organizationId, propertyId, { cache: "no-store" });
    },

    /** Records that the published prices are final, binding the current pricing source. */
    async confirmFinalPrices(
      organizationId: string,
      propertyId: string,
    ): Promise<OnboardingPricingOwners> {
      const current = await load(organizationId, propertyId, { cache: "no-store" });
      if (current.confirmationCurrent) return current;
      if (!current.pricing || !current.recurringPricing) {
        throw new PricingOwnerError(
          messages.pricing_source_not_configured!,
          "pricing_source_not_configured",
          true,
        );
      }
      const source = mandatoryChargeSource(
        current.rooms,
        current.pricing,
        current.recurringPricing,
      );
      const body = {
        expectedConfirmationRevision: current.confirmationRevision,
        claimedPricingSourceFingerprint: await sha256Hex(source.serializedPayload),
        expectedPricingSourceRevisions: source.sourceRevisions,
      };
      const value = await ownerPut(
        http,
        path(propertyId, "mandatory-charge-confirmation"),
        body,
        await commandKey("mandatory-charge-confirmation", propertyId, body),
        "confirmation",
      );
      const result = parseConfirmMandatoryChargesIncludedResult({ ok: true, response: value });
      if (
        !result?.ok ||
        result.response.evidence.organizationId !== organizationId.toLowerCase() ||
        result.response.evidence.propertyId !== propertyId.toLowerCase() ||
        result.response.evidence.pricingSourceFingerprint !== body.claimedPricingSourceFingerprint
      ) {
        throw invalidOwnerContract("final-price confirmation receipt");
      }
      const confirmed = await load(organizationId, propertyId, { cache: "no-store" });
      if (!confirmed.confirmationCurrent) {
        throw new PricingOwnerError(
          messages.pricing_source_conflict!,
          "pricing_source_conflict",
          true,
        );
      }
      return confirmed;
    },

    /** The pricing-v2 client (publication, drafts, terms) on the same API session. */
    replacementPricing(propertyId: string) {
      return createReplacementPricingClient(propertyId, {
        http,
        isNotFound: (error) =>
          error instanceof ApiErrorResponse &&
          error.status === 404 &&
          error.data.code === "not_found",
        conflict: (detail) => new ApiErrorResponse(409, { code: "stale", detail }),
      });
    },
  };
}

function mandatoryChargeSource(
  rooms: readonly RoomTypeFactsSnapshot[],
  pricing: PmsPricingSourceSnapshot,
  recurringPricing: PmsRecurringPricingBookingEvidence,
) {
  return createPmsMandatoryChargePricingSourceSnapshot({
    rooms: rooms.map((room) => ({
      roomTypeId: room.roomTypeId,
      roomFactsRevision: room.roomFactsRevision,
      occupancy: room.facts.occupancy,
    })),
    pricing,
    recurringPricing,
  });
}

async function sourceFingerprint(
  rooms: readonly RoomTypeFactsSnapshot[],
  pricing: PmsPricingSourceSnapshot,
  recurringPricing: PmsRecurringPricingBookingEvidence,
) {
  return sha256Hex(mandatoryChargeSource(rooms, pricing, recurringPricing).serializedPayload);
}

function parseRooms(value: unknown, propertyId: string): RoomTypeFactsSnapshot[] | null {
  if (
    !isExactRecord(value, ["contractVersion", "propertyId", "items"]) ||
    value.contractVersion !== PMS_ROOM_FACTS_CONTRACT_VERSION ||
    value.propertyId !== propertyId ||
    !Array.isArray(value.items)
  ) {
    return null;
  }
  const rooms = value.items.map(parseRoomTypeFactsSnapshot);
  if (
    rooms.some((room) => !room || room.propertyId !== propertyId) ||
    new Set(rooms.map((room) => room?.roomTypeId)).size !== rooms.length
  ) {
    return null;
  }
  return (rooms as RoomTypeFactsSnapshot[])
    .filter(({ lifecycle }) => lifecycle === "active")
    .sort((left, right) => left.facts.name.localeCompare(right.facts.name));
}

async function optionalGet(
  http: OnboardingPricingHttpClient,
  endpoint: string,
  options?: RequestInit,
): Promise<unknown | null> {
  try {
    return await http.get<unknown>(endpoint, options);
  } catch (error) {
    if (
      error instanceof ApiErrorResponse &&
      error.status === 404 &&
      error.data.code === "pricing_currency_not_configured"
    ) {
      return null;
    }
    throw error;
  }
}

async function confirmationGet(
  http: OnboardingPricingHttpClient,
  organizationId: string,
  propertyId: string,
  options?: RequestInit,
) {
  let value: unknown;
  try {
    value = await http.get<unknown>(
      `/api/pms/properties/${encodeURIComponent(propertyId)}/mandatory-charge-confirmation`,
      options,
    );
  } catch (error) {
    if (!(error instanceof ApiErrorResponse) || error.status !== 404) throw error;
    value = error.data;
  }
  const result = parsePmsMandatoryChargeConfirmationReadResult(value);
  if (
    result?.organizationId !== organizationId.toLowerCase() ||
    result.propertyId !== propertyId.toLowerCase() ||
    (result.outcome !== "available" && result.outcome !== "missing")
  ) {
    throw invalidOwnerContract("final-price confirmation");
  }
  return result.outcome === "available" ? result.evidence : null;
}

async function ownerPut(
  http: OnboardingPricingHttpClient,
  endpoint: string,
  body: unknown,
  idempotencyKey: string,
  kind: "currency" | "confirmation",
): Promise<unknown> {
  try {
    return await http.put<unknown>(endpoint, body, {
      headers: { "Idempotency-Key": idempotencyKey },
    });
  } catch (error) {
    if (!(error instanceof ApiErrorResponse)) throw error;
    const wrapped = { ok: false as const, error: error.data as unknown };
    const result =
      kind === "currency"
        ? parsePropertyPricingCurrencyCommandResult(wrapped)
        : parseConfirmMandatoryChargesIncludedResult(wrapped);
    if (!result || result.ok) throw invalidOwnerContract(`${kind} command error`);
    const code = result.error.code;
    throw new PricingOwnerError(
      messages[code] ?? "Pricing could not be saved. Try again.",
      code,
      code.includes("conflict") || code === "setup_scope_unavailable",
    );
  }
}

async function commandKey(label: string, propertyId: string, value: unknown): Promise<string> {
  const digest = await sha256Hex(JSON.stringify(value));
  return `${label}:${propertyId}:${digest.slice(0, 40)}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function invalidOwnerContract(name: string): PricingOwnerError {
  return new PricingOwnerError(
    `The ${name} returned invalid data. Refresh the page and try again.`,
    "owner_contract_violation",
    true,
  );
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export const onboardingPricingApi = createOnboardingPricingClient(targetApiClient);
