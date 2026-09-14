import {
  INVENTORY_RULE_DAYS,
  inventoryRulesOverlap,
  type ChannexInventoryRule,
} from "@vayada/domain-pms-channex";

export type InventoryRulesPlan = {
  propertyId: string;
  externalPropertyId: string;
  rules: ChannexInventoryRule[];
  roomMappings: Record<string, string>;
};
type Request = (
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: unknown,
) => Promise<unknown>;
type Item = {
  id: string;
  attributes: Record<string, unknown>;
  relationships?: {
    property?: { data?: { id?: string } };
    properties?: { data?: Array<{ id?: string }> };
  };
};
const path = "/api/v1/channel_availability_rules";
function invalid(message: string): never {
  throw { ok: false, code: "invalid_state", message };
}

async function list(request: Request, collection: string, propertyId: string): Promise<Item[]> {
  const items: Item[] = [];
  for (let page = 1; page <= 100; page++) {
    const query = new URLSearchParams({
      "filter[property_id]": propertyId,
      "pagination[page]": String(page),
      "pagination[limit]": "100",
    });
    const result = (await request(`${collection}?${query}`, "GET")) as {
      data?: Item[];
      meta?: { total?: number };
    };
    if (!Array.isArray(result.data)) invalid("Channex returned an invalid collection.");
    for (const item of result.data) {
      const propertyIds =
        item.relationships?.properties?.data?.map((property) => property.id) ??
        (Array.isArray(item.attributes?.properties) ? item.attributes.properties : []);
      const belongs =
        (item.relationships?.property?.data?.id ?? item.attributes?.property_id) === propertyId ||
        (collection === "/api/v1/channels" && propertyIds.includes(propertyId));
      if (!item.id || !item.attributes || !belongs)
        invalid("Channex returned an item outside the current property or omitted its scope.");
    }
    items.push(...result.data);
    if (
      typeof result.meta?.total === "number"
        ? items.length >= result.meta.total
        : result.data.length < 100
    )
      return items;
    if (!result.data.length) invalid("Channex pagination ended before the reported total.");
  }
  return invalid("Channex collection exceeds the supported page limit.");
}

export async function reconcileChannexInventoryRules(plan: InventoryRulesPlan, request: Request) {
  const prefix = `Vayada inventory ${plan.propertyId}:`;
  const channels = await list(request, "/api/v1/channels", plan.externalPropertyId);
  const desired = plan.rules.map((rule) => {
    if (
      rule.channelIds.some(
        (id) =>
          !channels.some((channel) => channel.id === id && channel.attributes.is_active === true),
      )
    )
      invalid(
        "An affected channel is no longer active on this property. Refresh and edit the rule.",
      );
    return {
      ...rule,
      roomTypeIds: rule.roomTypeIds.map(
        (id) =>
          plan.roomMappings[id] ??
          invalid("An affected room type no longer has an active Channex mapping."),
      ),
    };
  });
  const existing = await list(request, path, plan.externalPropertyId);
  const owned = existing.filter(
    (item) => typeof item.attributes.title === "string" && item.attributes.title.startsWith(prefix),
  );
  // Retained rules keep their old scopes until PUT succeeds. Reject scope swaps
  // rather than creating an intermediate overlap with undefined precedence.
  const retained = existing.filter(
    (item) =>
      !owned.includes(item) ||
      desired.some((rule) => item.attributes.title === `${prefix}${rule.id}`),
  );
  for (const item of retained) {
    const attrs = item.attributes;
    if (
      !Array.isArray(attrs.affected_channels) ||
      !Array.isArray(attrs.affected_room_types) ||
      typeof attrs.start_date !== "string"
    )
      invalid("An existing provider rule has an unsupported scope. Review it in channel settings.");
    const scope = {
      channelIds: attrs.affected_channels,
      roomTypeIds: attrs.affected_room_types,
      startDate: attrs.start_date,
      endDate: attrs.end_date ?? "9999-12-31",
      days: Array.isArray(attrs.days) && attrs.days.length ? attrs.days : [...INVENTORY_RULE_DAYS],
    } as ChannexInventoryRule;
    if (
      desired.some(
        (rule) =>
          item.attributes.title !== `${prefix}${rule.id}` && inventoryRulesOverlap(rule, scope),
      )
    )
      invalid(
        "An existing rule in Channex overlaps this channel, room type and date. Move or remove the conflicting rule first; simultaneous scope swaps are not supported.",
      );
  }
  for (const item of owned) {
    if (!desired.some((rule) => item.attributes.title === `${prefix}${rule.id}`))
      await request(`${path}/${encodeURIComponent(item.id)}`, "DELETE");
  }
  for (const rule of desired) {
    const title = `${prefix}${rule.id}`;
    const matches = owned.filter((item) => item.attributes.title === title);
    if (matches.length > 1)
      invalid("Duplicate provider rule identities require reconciliation in channel settings.");
    const body = {
      channel_availability_rule: {
        title,
        property_id: plan.externalPropertyId,
        type: rule.type,
        value: rule.value,
        affected_channels: rule.channelIds,
        affected_room_types: rule.roomTypeIds,
        start_date: rule.startDate,
        end_date: rule.endDate,
        days: rule.days,
      },
    };
    const existingId = matches[0]?.id;
    const response = (await request(
      existingId ? `${path}/${encodeURIComponent(existingId)}` : path,
      existingId ? "PUT" : "POST",
      body,
    )) as { data?: { id?: string } };
    if (!response.data?.id)
      throw new Error("Channex did not confirm the inventory rule identity. Retry to reconcile.");
  }
  return channels;
}
