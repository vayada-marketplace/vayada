import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  parsePmsPricingCurrencyCapabilities,
  parsePmsPricingSourceSnapshot,
  parsePropertyPricingCurrencyCommandResult,
  parseRoomTypeFactsSnapshot,
  type PmsPricingSourceSnapshot,
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

/** Live PMS owner state the onboarding pricing step needs besides the pricing-v2 publication.
 * Completion and the final-price confirmation come from the server's setup route. */
export type OnboardingPricingOwners = {
  /** Supported currency codes; the capabilities contract requires them sorted. */
  currencies: readonly string[];
  /** Active room types, in name order. */
  rooms: readonly RoomTypeFactsSnapshot[];
  pricing: PmsPricingSourceSnapshot | null;
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
  pricing_currency_change_blocked:
    "The currency is already used by pricing, payments, bookings, or publication. Keep the current currency.",
  pricing_currency_revision_conflict: "The pricing currency changed in another session.",
  command_in_progress: "This save is still processing. Retry in a moment.",
  setup_scope_unavailable: "Pricing access is no longer available for this hotel.",
};

export function createOnboardingPricingClient(http: OnboardingPricingHttpClient) {
  const path = (propertyId: string, suffix: string) =>
    `/api/pms/properties/${encodeURIComponent(propertyId)}/${suffix}`;

  async function load(propertyId: string, options?: RequestInit): Promise<OnboardingPricingOwners> {
    const [capabilitiesValue, roomsValue, pricingValue] = await Promise.all([
      http.get<unknown>(path(propertyId, "pricing-source/currency-capabilities"), options),
      http.get<unknown>(
        `/api/pms/setup/properties/${encodeURIComponent(propertyId)}/room-types`,
        options,
      ),
      optionalGet(http, path(propertyId, "pricing-source"), options),
    ]);
    const capabilities = parsePmsPricingCurrencyCapabilities(capabilitiesValue);
    const rooms = parseRooms(roomsValue, propertyId.toLowerCase());
    const pricing = pricingValue === null ? null : parsePmsPricingSourceSnapshot(pricingValue);
    if (
      !capabilities ||
      !rooms ||
      (pricingValue !== null && pricing?.propertyId !== propertyId.toLowerCase())
    ) {
      throw invalidOwnerContract("pricing workspace");
    }
    return {
      currencies: capabilities.supportedCurrencies.map(({ code }) => code),
      rooms,
      pricing,
    };
  }

  return {
    load,

    /** Saves the hotel's one pricing currency through the PMS currency route. */
    async saveCurrency(
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
      );
      const result = parsePropertyPricingCurrencyCommandResult({ ok: true, response: value });
      if (
        !result?.ok ||
        result.response.pricingCurrency.propertyId !== propertyId.toLowerCase() ||
        result.response.pricingCurrency.currency !== currency
      ) {
        throw invalidOwnerContract("pricing currency receipt");
      }
      return load(propertyId, { cache: "no-store" });
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

async function ownerPut(
  http: OnboardingPricingHttpClient,
  endpoint: string,
  body: unknown,
  idempotencyKey: string,
): Promise<unknown> {
  try {
    return await http.put<unknown>(endpoint, body, {
      headers: { "Idempotency-Key": idempotencyKey },
    });
  } catch (error) {
    if (!(error instanceof ApiErrorResponse)) throw error;
    const result = parsePropertyPricingCurrencyCommandResult({
      ok: false,
      error: error.data as unknown,
    });
    // Gate responses (authentication, Owner-only access, request validation) are not command
    // errors: pass them through unchanged instead of reporting invalid data.
    if (!result || result.ok) throw error;
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
