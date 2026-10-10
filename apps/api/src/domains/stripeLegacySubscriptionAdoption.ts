import { Buffer } from "node:buffer";

import {
  FINANCE_LEGACY_ADOPTION_METADATA_KEY,
  FINANCE_LEGACY_ADOPTION_METADATA_VALUE,
  FINANCE_LEGACY_PRODUCT_METADATA_KEY,
} from "@vayada/domain-finance";

import type {
  LegacyAdoptionStripe,
  LegacySubscriptionInspection,
} from "./financeLegacySubscriptionAdoption.js";
import { subscriptionSnapshot } from "./stripeFinanceSubscriptions.js";

type StripeObject = Record<string, unknown>;

/**
 * VAY-1362: the Stripe side of legacy fixed-plan adoption. One metadata write
 * per subscription; the item, price, quantity and billing cycle are never
 * touched here. Reads use the platform account like the legacy code did.
 */
export function createStripeLegacySubscriptionAdoption(config: {
  secretKey: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
}): LegacyAdoptionStripe {
  const endpoint = config.endpoint ?? "https://api.stripe.com/v1";
  const fetchImpl = config.fetch ?? globalThis.fetch;

  const request = async (
    method: "GET" | "POST",
    path: string,
    fields: ReadonlyArray<readonly [string, string]> = [],
    idempotencyKey?: string,
  ): Promise<StripeObject> => {
    const query = new URLSearchParams(fields.map(([key, value]): [string, string] => [key, value]));
    const response = await fetchImpl(
      `${endpoint}${path}${method === "GET" && fields.length ? `?${query}` : ""}`,
      {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.secretKey}:`).toString("base64")}`,
          ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        ...(method === "POST" ? { body: query.toString() } : {}),
      },
    );
    const payload = asObject(await response.json());
    if (!response.ok) {
      const error = asObject(payload["error"]);
      throw new Error(text(error["message"]) ?? `Stripe request failed with ${response.status}.`);
    }
    return payload;
  };

  return {
    async inspectLegacySubscription(subscriptionId) {
      const raw = await request("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
      return inspectLegacySubscription(raw);
    },

    async markAdopted(input) {
      await request(
        "POST",
        `/subscriptions/${encodeURIComponent(input.subscriptionId)}`,
        [
          ["metadata[vayada_property_id]", input.propertyId],
          ["metadata[vayada_organization_id]", input.organizationId],
          ["metadata[vayada_plan]", "fixed"],
          [
            `metadata[${FINANCE_LEGACY_ADOPTION_METADATA_KEY}]`,
            FINANCE_LEGACY_ADOPTION_METADATA_VALUE,
          ],
          [`metadata[${FINANCE_LEGACY_PRODUCT_METADATA_KEY}]`, input.productId],
        ],
        input.idempotencyKey,
      );
    },

    async findLegacySubscriptionsForHotel(hotelId) {
      const found: Array<{ subscriptionId: string; status: string }> = [];
      let page: string | undefined;
      while (true) {
        const fields: Array<readonly [string, string]> = [
          [
            "query",
            `metadata['hotel_id']:'${hotelId.replaceAll("'", "")}' AND metadata['vayada_payment_kind']:'fixed_plan'`,
          ],
          ["limit", "100"],
        ];
        if (page) fields.push(["page", page]);
        const response = await request("GET", "/subscriptions/search", fields);
        for (const item of objectArray(response["data"])) {
          const subscriptionId = text(item["id"]);
          if (subscriptionId) {
            found.push({ subscriptionId, status: text(item["status"]) ?? "unknown" });
          }
        }
        const nextPage = text(response["next_page"]);
        if (response["has_more"] !== true || !nextPage || nextPage === page) break;
        page = nextPage;
      }
      return found;
    },
  };
}

export function inspectLegacySubscription(raw: StripeObject): LegacySubscriptionInspection {
  const snapshot = subscriptionSnapshot(raw);
  const metadata = asObject(raw["metadata"]);
  const items = objectArray(asObject(raw["items"])["data"]);
  const item = items[0] ?? {};
  const price = asObject(item["price"]);
  const recurring = asObject(price["recurring"]);
  const unitAmount = Number(price["unit_amount"]);
  const product = price["product"];
  const flatThirtyDayPrice =
    items.length === 1 &&
    text(price["billing_scheme"]) === "per_unit" &&
    text(price["currency"])?.toUpperCase() === "EUR" &&
    text(recurring["usage_type"]) === "licensed" &&
    text(recurring["interval"]) === "day" &&
    Number(recurring["interval_count"]) === 30 &&
    Number.isInteger(unitAmount) &&
    unitAmount > 0 &&
    Number(item["quantity"]) === 1;
  return {
    snapshot,
    hotelId: text(metadata["hotel_id"]),
    paymentKind: text(metadata["vayada_payment_kind"]),
    flatThirtyDayPrice,
    unitAmountMinor: flatThirtyDayPrice ? unitAmount : null,
    productId: typeof product === "string" ? text(product) : text(asObject(product)["id"]),
    adoptionMarker: text(metadata[FINANCE_LEGACY_ADOPTION_METADATA_KEY]),
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asObject(value: unknown): StripeObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as StripeObject) : {};
}

function objectArray(value: unknown): StripeObject[] {
  return Array.isArray(value) ? value.map(asObject) : [];
}
