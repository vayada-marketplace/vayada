export interface LastMinuteTier {
  daysBeforeMin: number;
  daysBeforeMax: number | null;
  discountPercent: number;
}

export interface LastMinuteConfig {
  enabled: boolean;
  stackWithPromo: boolean;
  tiers: LastMinuteTier[];
}

interface LastMinuteConfigInput {
  enabled?: boolean;
  stackWithPromo?: boolean;
  stack_with_promo?: boolean;
  tiers?: LastMinuteTier[] | null;
}

export interface LastMinuteConfigPayload {
  last_minute_discount?: LastMinuteConfigInput | null;
  lastMinuteDiscount?: LastMinuteConfigInput | null;
}

export function normalizeLastMinuteConfig(
  config: LastMinuteConfigInput | null | undefined,
): LastMinuteConfig | null {
  if (!config) return null;

  return {
    enabled: !!config.enabled,
    stackWithPromo: !!(config.stackWithPromo ?? config.stack_with_promo),
    tiers: Array.isArray(config.tiers) ? config.tiers : [],
  };
}

export function getLastMinuteConfigFromPayload(
  payload: LastMinuteConfigPayload | null | undefined,
): LastMinuteConfig | null {
  return normalizeLastMinuteConfig(payload?.last_minute_discount ?? payload?.lastMinuteDiscount);
}
