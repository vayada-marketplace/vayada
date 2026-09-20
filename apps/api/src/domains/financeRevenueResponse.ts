import {
  PMS_FINANCIALS_CONTRACT_VERSION,
  divideFinanceReportingDecimal,
  financeReportingCountMetric,
  financeReportingMoneyMetric,
  financeReportingRatioMetric,
  normalizeFinanceReportingDecimal,
  type FinanceReportingIncompleteEvidence,
  type FinanceReportingMoney,
  type FinanceRevenueResponse,
} from "@vayada/domain-finance";

import type {
  FinanceRevenueAddonFacts,
  FinanceRevenueAddonGap,
} from "./financeRevenueAddonFacts.js";
import type {
  FinanceRevenueRoomFact,
  FinanceRevenueRoomFacts,
  FinanceRevenueRoomGap,
} from "./financeRevenueRoomFacts.js";

type FinanceRevenueGap = FinanceRevenueRoomGap | FinanceRevenueAddonGap;

export type FinanceRevenueResponseInput = {
  propertyId: string;
  currency: string;
  timeZone: string;
  generatedAt: string;
  sourceFreshness?: Record<string, string>;
  rooms: FinanceRevenueRoomFacts;
  addOns: FinanceRevenueAddonFacts;
};

export function composeFinanceRevenueResponse(
  input: FinanceRevenueResponseInput,
): FinanceRevenueResponse {
  if (
    !/^[0-9a-f-]{36}$/i.test(input.propertyId) ||
    !/^[A-Z]{3}$/.test(input.currency) ||
    !input.timeZone.trim() ||
    !Number.isFinite(new Date(input.generatedAt).getTime())
  )
    throw new TypeError("Finance revenue response scope is invalid");
  const current = totals(input, "current");
  const comparison = totals(input, "comparison");
  const [roomTypeRows, roomTypeGap] = roomTypes(input.rooms.rows, input.currency);
  return {
    contractVersion: PMS_FINANCIALS_CONTRACT_VERSION,
    propertyId: input.propertyId.toLowerCase(),
    currency: input.currency,
    timeZone: input.timeZone,
    generatedAt: new Date(input.generatedAt).toISOString(),
    sourceFreshness: freshness(input),
    incompleteEvidence: [
      ...input.rooms.incompleteEvidence.map(incomplete),
      ...input.addOns.incompleteEvidence.map(incomplete),
      ...(roomTypeGap ? [{ code: "room_type_occupancy_unavailable", count: roomTypeGap }] : []),
    ],
    summary: {
      grossRoom: financeReportingMoneyMetric(current.gross, comparison.gross, input.currency),
      otaCommission: financeReportingMoneyMetric(
        current.commission,
        comparison.commission,
        input.currency,
      ),
      netRoom: financeReportingMoneyMetric(current.net, comparison.net, input.currency),
      upsell: financeReportingMoneyMetric(current.upsell, comparison.upsell, input.currency),
      nights: financeReportingCountMetric(current.nights, comparison.nights),
      adr: financeReportingMoneyMetric(current.adr, comparison.adr, input.currency),
      attachRate: financeReportingRatioMetric(
        {
          numerator: input.addOns.fulfilledBookings.current,
          denominator: input.rooms.eligibleBookings.current,
        },
        {
          numerator: input.addOns.fulfilledBookings.comparison,
          denominator: input.rooms.eligibleBookings.comparison,
        },
      ),
    },
    channels: channels(input.rooms.rows, input.currency),
    directSources: directSources(input.rooms.rows, input.currency),
    upsells: upsells(input.addOns, input.currency),
    roomTypes: roomTypeRows,
  };
}

function totals(input: FinanceRevenueResponseInput, period: "current" | "comparison") {
  const rooms = input.rooms.rows.filter((row) => row.period === period);
  const gross = sum(rooms.map((row) => row.grossRoomAmount));
  const commission = sum(rooms.map((row) => row.otaCommissionAmount));
  const nights = Math.max(
    0,
    rooms.reduce((total, row) => total + row.occupiedRoomNights, 0),
  );
  const pricedNights = Math.max(
    0,
    rooms.reduce((total, row) => total + row.pricedOccupiedRoomNights, 0),
  );
  return {
    gross,
    commission,
    net: decimal(units(gross) - units(commission)),
    upsell: sum(
      input.addOns.rows.filter((row) => row.period === period).map((row) => row.revenueAmount),
    ),
    nights,
    adr: divideFinanceReportingDecimal(gross, pricedNights),
  };
}

function channels(rows: FinanceRevenueRoomFact[], currency: string) {
  const grouped = new Map<string, { gross: bigint; commission: bigint }>();
  for (const row of rows.filter(({ period }) => period === "current")) {
    const value = grouped.get(row.channel) ?? { gross: 0n, commission: 0n };
    value.gross += units(row.grossRoomAmount);
    value.commission += units(row.otaCommissionAmount);
    grouped.set(row.channel, value);
  }
  const total = [...grouped.values()].reduce((value, row) => value + positive(row.gross), 0n);
  return [...grouped]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([channel, value]) => ({
      channel,
      gross: money(value.gross, currency),
      commission: money(value.commission, currency),
      net: money(value.gross - value.commission, currency),
      share: fraction(positive(value.gross), total),
    }));
}

function directSources(rows: FinanceRevenueRoomFact[], currency: string) {
  const grouped = new Map<string, bigint>();
  for (const row of rows.filter(
    ({ period, channel, directSource }) =>
      period === "current" && channel === "direct" && directSource !== null,
  ))
    grouped.set(
      row.directSource!,
      (grouped.get(row.directSource!) ?? 0n) + units(row.grossRoomAmount),
    );
  const total = [...grouped.values()].reduce((value, amount) => value + positive(amount), 0n);
  return [...grouped]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, revenue]) => ({
      source,
      revenue: money(revenue, currency),
      share: fraction(positive(revenue), total),
    }));
}

function upsells(facts: FinanceRevenueAddonFacts, currency: string) {
  return (["property", "partner"] as const).map((ownership) => ({
    ownership,
    revenue: money(
      facts.rows
        .filter((row) => row.period === "current" && row.ownership === ownership)
        .reduce((total, row) => total + units(row.revenueAmount), 0n),
      currency,
    ),
  }));
}

function roomTypes(rows: FinanceRevenueRoomFact[], currency: string) {
  const grouped = new Map<string, { revenue: bigint; nights: number; pricedNights: number }>();
  for (const row of rows.filter(({ period }) => period === "current")) {
    const value = grouped.get(row.roomTypeId) ?? { revenue: 0n, nights: 0, pricedNights: 0 };
    value.revenue += units(row.grossRoomAmount);
    value.nights += row.occupiedRoomNights;
    value.pricedNights += row.pricedOccupiedRoomNights;
    grouped.set(row.roomTypeId, value);
  }
  const unavailable = [...grouped.values()].filter(({ nights }) => nights < 0).length;
  if (unavailable) return [[] as FinanceRevenueResponse["roomTypes"], unavailable] as const;
  return [
    [...grouped]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([roomTypeId, value]) => ({
        roomTypeId,
        nights: value.nights,
        revenue: money(value.revenue, currency),
        adr: money(
          units(
            divideFinanceReportingDecimal(decimal(value.revenue), Math.max(0, value.pricedNights)),
          ),
          currency,
        ),
      })),
    0,
  ] as const;
}

function freshness(input: FinanceRevenueResponseInput): Record<string, string> {
  const values: Record<string, string | null> = {
    ...input.sourceFreshness,
    ...input.rooms.sourceFreshness,
    ...input.addOns.sourceFreshness,
  };
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null),
  );
}

function incomplete(value: FinanceRevenueGap): FinanceReportingIncompleteEvidence {
  if ("amount" in value && value.amount)
    return { code: value.code, count: value.count, amount: value.amount };
  return "currency" in value
    ? { code: value.code, count: value.count, currency: value.currency }
    : { code: value.code, count: value.count };
}
function sum(values: string[]): string {
  return decimal(values.reduce((total, value) => total + units(value), 0n));
}
function money(value: bigint, currency: string): FinanceReportingMoney {
  return { amount: decimal(value), currency };
}
function fraction(numerator: bigint, denominator: bigint): string {
  return decimal(denominator === 0n ? 0n : rounded(numerator * 10_000n, denominator));
}
const positive = (value: bigint) => (value > 0n ? value : 0n);
function units(value: string): bigint {
  const normalized = normalizeFinanceReportingDecimal(value);
  const negative = normalized.startsWith("-");
  const [whole, fractionValue] = normalized.replace("-", "").split(".");
  const valueUnits = BigInt(whole!) * 10_000n + BigInt(fractionValue!);
  return negative ? -valueUnits : valueUnits;
}
function decimal(value: bigint): string {
  const negative = value < 0n,
    absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 10_000n}.${String(absolute % 10_000n).padStart(4, "0")}`;
}
function rounded(value: bigint, divisor: bigint): bigint {
  const sign = value < 0n !== divisor < 0n ? -1n : 1n;
  const absolute = value < 0n ? -value : value,
    denominator = divisor < 0n ? -divisor : divisor;
  return sign * ((absolute + denominator / 2n) / denominator);
}
