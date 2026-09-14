export const INVENTORY_RULE_DAYS = ["su", "mo", "tu", "we", "th", "fr", "sa"] as const;
export type InventoryRuleDay = (typeof INVENTORY_RULE_DAYS)[number];
export type ChannexInventoryRule = {
  id: string;
  type: "availability_offset" | "max_availability" | "close_out";
  value: number | null;
  channelIds: string[];
  roomTypeIds: string[];
  startDate: string;
  endDate: string;
  days: InventoryRuleDay[];
};
export type ChannexInventoryRulesInput = {
  expectedOperationId: string | null;
  rules: ChannexInventoryRule[];
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function ids(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 100 &&
    value.every((id) => typeof id === "string" && uuid.test(id)) &&
    new Set(value).size === value.length
  );
}
function date(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function parseInventoryRules(value: unknown): ChannexInventoryRulesInput | null {
  if (!value || typeof value !== "object") return null;
  const input = value as ChannexInventoryRulesInput;
  if (
    input.expectedOperationId !== null &&
    (typeof input.expectedOperationId !== "string" || !uuid.test(input.expectedOperationId))
  )
    return null;
  if (!Array.isArray(input.rules) || input.rules.length > 50) return null;
  for (const rule of input.rules) {
    if (
      !rule ||
      typeof rule !== "object" ||
      typeof rule.id !== "string" ||
      !uuid.test(rule.id) ||
      !ids(rule.channelIds) ||
      !ids(rule.roomTypeIds) ||
      !date(rule.startDate) ||
      !date(rule.endDate) ||
      rule.endDate < rule.startDate ||
      !Array.isArray(rule.days) ||
      !rule.days.length ||
      rule.days.some((day) => !INVENTORY_RULE_DAYS.includes(day)) ||
      new Set(rule.days).size !== rule.days.length
    )
      return null;
    if (rule.type === "close_out") {
      if (rule.value !== null) return null;
    } else if (
      !["availability_offset", "max_availability"].includes(rule.type) ||
      !Number.isInteger(rule.value) ||
      rule.value! < 0 ||
      rule.value! > 9999
    )
      return null;
  }
  if (new Set(input.rules.map((rule) => rule.id.toLowerCase())).size !== input.rules.length)
    return null;
  return {
    expectedOperationId: input.expectedOperationId,
    rules: input.rules
      .map((rule) => ({
        id: rule.id.toLowerCase(),
        type: rule.type,
        value: rule.value,
        channelIds: rule.channelIds.map((id) => id.toLowerCase()).sort(),
        roomTypeIds: rule.roomTypeIds.map((id) => id.toLowerCase()).sort(),
        startDate: rule.startDate,
        endDate: rule.endDate,
        days: [...rule.days].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function inventoryRulesOverlap(a: ChannexInventoryRule, b: ChannexInventoryRule): boolean {
  if (
    !a.channelIds.some((id) => b.channelIds.includes(id)) ||
    !a.roomTypeIds.some((id) => b.roomTypeIds.includes(id))
  )
    return false;
  const start = a.startDate > b.startDate ? a.startDate : b.startDate;
  const end = a.endDate < b.endDate ? a.endDate : b.endDate;
  const day = new Date(`${start}T00:00:00Z`);
  for (
    let i = 0;
    i < 7 && day.toISOString().slice(0, 10) <= end;
    i++, day.setUTCDate(day.getUTCDate() + 1)
  ) {
    const weekday = INVENTORY_RULE_DAYS[day.getUTCDay()]!;
    if (a.days.includes(weekday) && b.days.includes(weekday)) return true;
  }
  return false;
}
