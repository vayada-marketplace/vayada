import type { ChannexConnectedChannel } from "@vayada/domain-pms-channex";

// Publish only a complete, property-scoped snapshot. Never follow provider URLs.
export async function readChannexChannels(
  firstPage: unknown,
  propertyId: string,
  fetchPage: (page: number) => Promise<unknown>,
): Promise<ChannexConnectedChannel[]> {
  const channels = new Map<string, ChannexConnectedChannel>();
  let body = firstPage;
  let total: number | undefined;
  let limit: number | undefined;
  for (let page = 1; page <= 100; page++) {
    const listing = record(body);
    const meta = record(listing.meta);
    if (
      !Array.isArray(listing.data) ||
      meta.page !== page ||
      !Number.isSafeInteger(meta.limit) ||
      (meta.limit as number) < 1 ||
      !Number.isSafeInteger(meta.total) ||
      (meta.total as number) < 0 ||
      (total !== undefined && total !== meta.total) ||
      (limit !== undefined && limit !== meta.limit)
    )
      throw new Error("Invalid Channex channel pagination");
    total = meta.total as number;
    limit = meta.limit as number;
    const expected = Math.min(limit, total - channels.size);
    if (listing.data.length !== expected) throw new Error("Incomplete Channex channel page");
    for (const value of listing.data) {
      const item = record(value);
      const attributes = record(item.attributes ?? item);
      const code = attributes.channel ?? attributes.application;
      if (
        typeof item.id !== "string" ||
        !item.id.trim() ||
        channels.has(item.id) ||
        typeof code !== "string" ||
        !code.trim() ||
        typeof attributes.is_active !== "boolean" ||
        !Array.isArray(attributes.properties) ||
        !attributes.properties.includes(propertyId)
      )
        throw new Error("Invalid or out-of-scope Channex channel");
      const alias = code.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
      channels.set(item.id, {
        nativeRateModifiers: nativeRateModifiers(attributes.settings),
        currency: typeof attributes.currency === "string" ? attributes.currency : null,
        externalChannelId: item.id,
        providerCode: code,
        key:
          alias === "bookingcom"
            ? "booking_com"
            : ["airbnb", "abnb"].includes(alias)
              ? "airbnb"
              : alias,
        application: code,
        title: typeof attributes.title === "string" ? attributes.title : null,
        isActive: attributes.is_active,
      });
    }
    if (channels.size === total) return [...channels.values()];
    if (page === 100) break;
    body = await fetchPage(page + 1);
  }
  throw new Error("Channex channel pagination exceeded the safety limit");
}

function nativeRateModifiers(settings: unknown): ChannexConnectedChannel["nativeRateModifiers"] {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const derived = (settings as Record<string, unknown>).derived_option;
  if (derived == null) return [];
  if (typeof derived !== "object" || Array.isArray(derived)) return null;
  const rules = (derived as Record<string, unknown>).rate;
  if (rules == null) return [];
  if (!Array.isArray(rules) || rules.length > 20) return null;
  const supported = [
    "increase_by_percent",
    "decrease_by_percent",
    "increase_by_amount",
    "decrease_by_amount",
  ];
  const result = [];
  for (const rule of rules) {
    if (
      !Array.isArray(rule) ||
      rule.length !== 2 ||
      !supported.includes(rule[0]) ||
      typeof rule[1] !== "string" ||
      !/^\d+(?:\.\d+)?$/.test(rule[1]) ||
      rule[1].length > 30
    )
      return null;
    result.push({ operation: rule[0] as string, value: rule[1] });
  }
  return result;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Channex channel response");
  return value as Record<string, unknown>;
}
