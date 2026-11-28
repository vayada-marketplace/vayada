import type {
  ChannelManagerChannel,
  ChannelManagerChannels,
  ChannelManagerMarkup,
  ChannelManagerMarkupRule,
  ChannelManagerOta,
} from "@vayada/domain-pms-channex";

import type {
  ChannelManagerChannelReader,
  ChannelManagerConnection,
} from "../domains/pmsChannelManagerView.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATIONS = new Set<ChannelManagerMarkupRule["operation"]>([
  "increase_by_percent",
  "decrease_by_percent",
  "increase_by_amount",
  "decrease_by_amount",
]);
const PAGE_LIMIT = 5;

type Item = { id?: unknown; attributes?: unknown; relationships?: unknown };
type Rules = readonly ChannelManagerMarkupRule[] | null;

/**
 * VAY-2606: Booking.com and Airbnb as Channex has them for one hotel, with the markup each adds, for the
 * read-only Channel manager page. GET only: the channels, and the hotel's own rate plans so a channel shared
 * by several hotels (one Airbnb account) counts only this hotel's listings. Each request has 5 seconds; a
 * successful read is kept for a minute and a failed one for 30 seconds, and people opening the page at the same
 * time share one read, so the page never eats into the rate limit the booking pull and the price sync share.
 * Nothing else from the channel (credentials, payout settings) leaves this function.
 */
export function createChannexChannelManagerChannelReader(config: {
  apiBaseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  now?: () => number;
  cacheMs?: number;
  failureCacheMs?: number;
}): ChannelManagerChannelReader {
  const request = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const cacheMs = config.cacheMs ?? 60_000;
  const failureCacheMs = config.failureCacheMs ?? 30_000;
  const cache = new Map<
    string,
    { at: number; ttl: number; value: Promise<ChannelManagerChannels> }
  >();

  const list = async (path: string, propertyId: string): Promise<Item[]> => {
    const items: Item[] = [];
    for (let page = 1; page <= PAGE_LIMIT; page++) {
      const query = new URLSearchParams({
        "filter[property_id]": propertyId,
        "pagination[page]": String(page),
        "pagination[limit]": "100",
      });
      const response = await request(new URL(`${path}?${query}`, config.apiBaseUrl), {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        headers: { "user-api-key": config.apiKey },
      });
      if (!response.ok) throw new Error(`channex_http_${response.status}`);
      const body = record(await response.json());
      if (!Array.isArray(body.data)) throw new Error("channex_collection_invalid");
      items.push(...(body.data as Item[]));
      const total = record(body.meta).total;
      if (typeof total === "number" ? items.length >= total : body.data.length < 100) return items;
      if (!body.data.length) throw new Error("channex_pagination_short");
    }
    throw new Error("channex_pagination_limit");
  };

  const read = async (externalPropertyId: string): Promise<ChannelManagerChannels> => {
    const [channels, ratePlans] = await Promise.all([
      list("/api/v1/channels", externalPropertyId),
      list("/api/v1/rate_plans", externalPropertyId),
    ]);
    // Another hotel's rate plan or channel is left out; one that doesn't say which hotel it's for fails the read.
    const ownRatePlans = new Set<string>();
    for (const item of ratePlans) {
      const property = propertyOf(item);
      if (typeof item.id !== "string" || property === null)
        throw new Error("channex_rate_plan_scope_missing");
      if (property === externalPropertyId) ownRatePlans.add(item.id);
    }
    const items: ChannelManagerChannel[] = [];
    for (const item of channels) {
      const attributes = record(item.attributes);
      if (typeof item.id !== "string" || !Array.isArray(attributes.properties))
        throw new Error("channex_channel_scope_missing");
      if (!attributes.properties.includes(externalPropertyId)) continue;
      const ota = otaOf(attributes.channel);
      if (!ota) continue;
      items.push(channel(ota, attributes, ownRatePlans));
    }
    items.sort((a, b) => (a.ota === b.ota ? 0 : a.ota === "booking_com" ? -1 : 1));
    return { status: "ok", items };
  };

  return async ({ externalPropertyId }: ChannelManagerConnection) => {
    if (!UUID.test(externalPropertyId)) throw new Error("channex_property_id_invalid");
    const cached = cache.get(externalPropertyId);
    if (cached && now() - cached.at < cached.ttl) return cached.value;
    // Kept while in flight, so a second reader waits for the same answer.
    const entry = { at: now(), ttl: cacheMs, value: read(externalPropertyId) };
    cache.set(externalPropertyId, entry);
    entry.value.catch(() => {
      if (cache.get(externalPropertyId) === entry)
        cache.set(externalPropertyId, { ...entry, at: now(), ttl: failureCacheMs });
    });
    return entry.value;
  };
}

function channel(
  ota: ChannelManagerOta,
  attributes: Record<string, unknown>,
  ownRatePlans: ReadonlySet<string>,
): ChannelManagerChannel {
  const settings = record(attributes.settings);
  const mappings = (Array.isArray(attributes.rate_plans) ? attributes.rate_plans : [])
    .map(record)
    .filter((mapping) => typeof mapping.rate_plan_id === "string")
    .filter((mapping) => ownRatePlans.has(mapping.rate_plan_id as string))
    .map((mapping) => record(mapping.settings));
  const mapped = new Set(
    mappings.map((mapping, index) => {
      const key = ota === "booking_com" ? mapping.room_type_code : mapping.listing_id;
      return typeof key === "string" || typeof key === "number" ? String(key) : `mapping:${index}`;
    }),
  );
  const hotelId = settings.hotel_id;
  return {
    ota,
    // A channel that maps none of this hotel's rooms (a shared Airbnb account) doesn't sell this hotel.
    active: attributes.is_active === true && mapped.size > 0,
    otaPropertyId:
      ota === "booking_com" && (typeof hotelId === "string" || typeof hotelId === "number")
        ? String(hotelId)
        : null,
    mappedCount: mapped.size,
    markup: markup(
      settings,
      mappings,
      typeof attributes.currency === "string" ? attributes.currency : null,
    ),
  };
}

/**
 * Channex applies the channel's own price rules to every mapped room or listing, unless that mapping sets its
 * own (which replace them, not add to them). The page shows one markup when every mapping ends up with the same
 * rules, "varies" when they don't, and "unknown" for a rule it can't read rather than guessing. A mapping's empty
 * rule list is read as unknown while the channel has rules: Channex documents an explicit zero rule as the way to
 * exempt a mapping, so "no markup" there could hide one Channex still applies (VAY-1550).
 */
export function markup(
  settings: Record<string, unknown>,
  mappings: readonly Record<string, unknown>[],
  currency: string | null,
): ChannelManagerMarkup {
  const own = rateRules(settings.derived_option);
  const effective = mappings.length
    ? mappings.map((mapping) => {
        const derived = mapping.derived_option;
        if (derived == null || typeof derived !== "object" || !("rate" in derived))
          return own.rules;
        const rate = (derived as Record<string, unknown>).rate;
        if (rate == null || (Array.isArray(rate) && rate.length === 0))
          return own.rules === null || own.rules.length > 0 ? null : [];
        return rateRules(derived).rules;
      })
    : [own.rules];
  if (effective.some((rules) => rules === null)) return { kind: "unknown" };
  const keys = new Set(effective.map((rules) => JSON.stringify(rules)));
  return keys.size === 1 ? { kind: "rules", rules: effective[0]!, currency } : { kind: "varies" };
}

function rateRules(derived: unknown): { rules: Rules } {
  if (derived == null) return { rules: [] };
  if (typeof derived !== "object" || Array.isArray(derived)) return { rules: null };
  const rate = (derived as Record<string, unknown>).rate;
  if (rate == null) return { rules: [] };
  if (!Array.isArray(rate) || rate.length > 20) return { rules: null };
  const rules: ChannelManagerMarkupRule[] = [];
  for (const rule of rate) {
    // Channex reads a decimal comma as a point: Tiga's Booking.com rule "21,17" adds 21.17%. Only one or two
    // digits after a comma count, so "1,000" (a thousand, or one?) stays unknown.
    if (
      !Array.isArray(rule) ||
      rule.length !== 2 ||
      !OPERATIONS.has(rule[0]) ||
      typeof rule[1] !== "string" ||
      !/^\d{1,9}(?:\.\d{1,4}|,\d{1,2})?$/.test(rule[1])
    )
      return { rules: null };
    const value = Number(rule[1].replace(",", "."));
    // A zero rule changes nothing; Channex uses ["increase_by_percent", "0"] to exempt a mapping.
    if (value === 0) continue;
    // "5", "5.00" and "5,00" are the same rule.
    rules.push({ operation: rule[0], value: String(value) });
  }
  return { rules };
}

function otaOf(code: unknown): ChannelManagerOta | null {
  if (typeof code !== "string") return null;
  const alias = code.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  if (alias === "bookingcom") return "booking_com";
  if (alias === "airbnb") return "airbnb";
  return null;
}

function propertyOf(item: Item): string | null {
  const attributes = record(item.attributes);
  const related = record(record(record(item.relationships).property).data).id;
  const id = typeof related === "string" ? related : attributes.property_id;
  return typeof id === "string" ? id : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
