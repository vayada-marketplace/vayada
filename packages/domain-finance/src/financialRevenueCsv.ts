import { getTimezone } from "countries-and-timezones";

import { financeCsvRow } from "./financialCsv.js";
import {
  parseFinanceRevenueQuery,
  type FinanceRevenueQuery,
  type FinanceRevenueResponse,
  type FinanceReportingMoney,
  type FinanceReportingMoneyMetric,
} from "./financialReporting.js";

export const FINANCE_REVENUE_CSV_VERSION = "pms-financials-revenue.v1" as const;
export const FINANCE_REVENUE_CSV_CONTENT_TYPE = "text/csv; charset=utf-8" as const;
export const FINANCE_REVENUE_CSV_COLUMNS = [
  "property_id",
  "from",
  "to",
  "row_type",
  "dimension",
  "metric",
  "value",
  "currency",
  "absolute_change",
  "percent_change",
] as const;

export type FinanceRevenueCsvArtifact = {
  formatVersion: typeof FINANCE_REVENUE_CSV_VERSION;
  contentType: typeof FINANCE_REVENUE_CSV_CONTENT_TYPE;
  propertyId: string;
  currency: string;
  filters: FinanceRevenueQuery;
  generatedAt: string;
  filename: string;
  rowCount: number;
  body: string;
};
export type FinanceRevenueExportSnapshot = Readonly<{
  formatVersion: typeof FINANCE_REVENUE_CSV_VERSION;
  propertyId: string;
  currency: string;
  timeZone: string;
  filters: FinanceRevenueQuery;
  snapshotAt: string;
  manifest: readonly [{ response: FinanceRevenueResponse }];
}>;

/** Copy only the public Revenue read contract into labeled CSV rows. */
export function buildFinanceRevenueCsvArtifact(input: {
  propertyId: string;
  response: FinanceRevenueResponse;
  query: FinanceRevenueQuery;
}): FinanceRevenueCsvArtifact {
  const { response, query } = input;
  const filters = parseFinanceRevenueQuery(query);
  if (
    !filters ||
    !uuid(response.propertyId) ||
    response.propertyId !== input.propertyId ||
    response.contractVersion !== "pms-financials.v1" ||
    !/^[A-Z]{3}$/.test(response.currency) ||
    !instant(response.generatedAt) ||
    !zone(response.timeZone) ||
    !validRevenue(response)
  )
    throw new TypeError("Revenue CSV read contract is invalid");

  const rows: string[][] = [];
  const add = (
    type: string,
    dimension: string,
    metric: string,
    value: string,
    currency = response.currency,
    change = "",
    percent = "",
  ) =>
    rows.push([
      response.propertyId,
      filters.from,
      filters.to,
      type,
      dimension,
      metric,
      value,
      currency,
      change,
      percent,
    ]);
  const summary = response.summary;
  for (const key of ["grossRoom", "otaCommission", "netRoom", "upsell", "adr"] as const) {
    const metric = summary[key];
    add(
      "summary",
      "",
      key,
      metric.value.amount,
      response.currency,
      metric.absoluteChange.amount,
      metric.percentChange ?? "",
    );
  }
  add(
    "summary",
    "",
    "nights",
    String(summary.nights.value),
    "",
    String(summary.nights.absoluteChange),
    summary.nights.percentChange ?? "",
  );
  add(
    "summary",
    "",
    "attachRate",
    summary.attachRate.value,
    "",
    summary.attachRate.absoluteChange,
    summary.attachRate.percentChange ?? "",
  );
  for (const channel of response.channels) {
    add("channel", channel.channel, "gross", channel.gross.amount);
    add("channel", channel.channel, "commission", channel.commission.amount);
    add("channel", channel.channel, "net", channel.net.amount);
    add("channel", channel.channel, "share", channel.share, "");
  }
  for (const source of response.directSources) {
    add("direct_source", source.source, "revenue", source.revenue.amount);
    add("direct_source", source.source, "share", source.share, "");
  }
  for (const upsell of response.upsells)
    add("upsell", upsell.ownership, "revenue", upsell.revenue.amount);
  for (const room of response.roomTypes) {
    add("room_type", room.roomTypeId, "nights", String(room.nights), "");
    add("room_type", room.roomTypeId, "revenue", room.revenue.amount);
    add("room_type", room.roomTypeId, "adr", room.adr.amount);
  }
  return {
    formatVersion: FINANCE_REVENUE_CSV_VERSION,
    contentType: FINANCE_REVENUE_CSV_CONTENT_TYPE,
    propertyId: response.propertyId,
    currency: response.currency,
    filters,
    generatedAt: response.generatedAt,
    filename: `pms-financials-revenue-${response.propertyId}-${filters.from}-${filters.to}.csv`,
    rowCount: rows.length,
    body: [FINANCE_REVENUE_CSV_COLUMNS, ...rows].map(financeCsvRow).join("\r\n") + "\r\n",
  };
}

/** Pin only CSV-needed read fields so durable retries never query newer financial evidence. */
export function captureFinanceRevenueExport(input: {
  propertyId: string;
  response: FinanceRevenueResponse;
  query: FinanceRevenueQuery;
}): FinanceRevenueExportSnapshot {
  const artifact = buildFinanceRevenueCsvArtifact(input);
  return {
    formatVersion: FINANCE_REVENUE_CSV_VERSION,
    propertyId: artifact.propertyId,
    currency: artifact.currency,
    timeZone: input.response.timeZone,
    filters: { ...artifact.filters },
    snapshotAt: artifact.generatedAt,
    manifest: [{ response: copyRevenueResponse(input.response) }],
  };
}

export function parseFinanceRevenueExportSnapshot(
  value: unknown,
): FinanceRevenueExportSnapshot | null {
  if (
    !record(value) ||
    !exact(value, [
      "formatVersion",
      "propertyId",
      "currency",
      "timeZone",
      "filters",
      "snapshotAt",
      "manifest",
    ])
  )
    return null;
  const filters = parseFinanceRevenueQuery(value.filters);
  if (
    value.formatVersion !== FINANCE_REVENUE_CSV_VERSION ||
    !uuid(value.propertyId) ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency) ||
    !filters ||
    !instant(value.snapshotAt) ||
    !Array.isArray(value.manifest) ||
    value.manifest.length !== 1
  )
    return null;
  const selection = value.manifest[0];
  if (!record(selection) || !exact(selection, ["response"])) return null;
  try {
    buildFinanceRevenueCsvArtifact({
      propertyId: value.propertyId,
      response: selection.response as FinanceRevenueResponse,
      query: filters,
    });
  } catch {
    return null;
  }
  const response = selection.response as FinanceRevenueResponse;
  if (
    response.currency !== value.currency ||
    response.generatedAt !== value.snapshotAt ||
    response.timeZone !== value.timeZone
  )
    return null;
  return {
    formatVersion: FINANCE_REVENUE_CSV_VERSION,
    propertyId: value.propertyId,
    currency: value.currency,
    timeZone: value.timeZone,
    filters,
    snapshotAt: value.snapshotAt,
    manifest: [{ response: copyRevenueResponse(response) }],
  };
}

function copyRevenueResponse(response: FinanceRevenueResponse): FinanceRevenueResponse {
  const money = (value: FinanceReportingMoney) => ({
    amount: value.amount,
    currency: value.currency,
  });
  const metric = (value: FinanceReportingMoneyMetric) => ({
    value: money(value.value),
    absoluteChange: money(value.absoluteChange),
    percentChange: value.percentChange,
  });
  return {
    contractVersion: response.contractVersion,
    propertyId: response.propertyId,
    currency: response.currency,
    timeZone: response.timeZone,
    generatedAt: response.generatedAt,
    sourceFreshness: {},
    incompleteEvidence: [],
    summary: {
      grossRoom: metric(response.summary.grossRoom),
      otaCommission: metric(response.summary.otaCommission),
      netRoom: metric(response.summary.netRoom),
      upsell: metric(response.summary.upsell),
      nights: {
        value: response.summary.nights.value,
        absoluteChange: response.summary.nights.absoluteChange,
        percentChange: response.summary.nights.percentChange,
      },
      adr: metric(response.summary.adr),
      attachRate: {
        value: response.summary.attachRate.value,
        absoluteChange: response.summary.attachRate.absoluteChange,
        percentChange: response.summary.attachRate.percentChange,
      },
    },
    channels: response.channels.map((item) => ({
      channel: item.channel,
      gross: money(item.gross),
      commission: money(item.commission),
      net: money(item.net),
      share: item.share,
    })),
    directSources: response.directSources.map((item) => ({
      source: item.source,
      revenue: money(item.revenue),
      share: item.share,
    })),
    upsells: response.upsells.map((item) => ({
      ownership: item.ownership,
      revenue: money(item.revenue),
    })),
    roomTypes: response.roomTypes.map((item) => ({
      roomTypeId: item.roomTypeId,
      nights: item.nights,
      revenue: money(item.revenue),
      adr: money(item.adr),
    })),
  };
}

function validRevenue(response: FinanceRevenueResponse): boolean {
  const code = response.currency;
  const summary = response.summary;
  const metric = (value: FinanceReportingMoneyMetric) =>
    validMoney(value.value, code) &&
    validMoney(value.absoluteChange, code) &&
    (value.percentChange === null || decimal(value.percentChange));
  return (
    [summary.grossRoom, summary.otaCommission, summary.netRoom, summary.upsell, summary.adr].every(
      metric,
    ) &&
    Number.isSafeInteger(summary.nights.value) &&
    summary.nights.value >= 0 &&
    Number.isSafeInteger(summary.nights.absoluteChange) &&
    (summary.nights.percentChange === null || decimal(summary.nights.percentChange)) &&
    ratio(summary.attachRate.value) &&
    decimal(summary.attachRate.absoluteChange) &&
    (summary.attachRate.percentChange === null || decimal(summary.attachRate.percentChange)) &&
    response.channels.every(
      (item) =>
        label(item.channel) &&
        validMoney(item.gross, code) &&
        validMoney(item.commission, code) &&
        validMoney(item.net, code) &&
        ratio(item.share),
    ) &&
    response.directSources.every(
      (item) => label(item.source) && validMoney(item.revenue, code) && ratio(item.share),
    ) &&
    response.upsells.every(
      (item) =>
        (item.ownership === "property" || item.ownership === "partner") &&
        validMoney(item.revenue, code),
    ) &&
    response.roomTypes.every(
      (item) =>
        uuid(item.roomTypeId) &&
        Number.isSafeInteger(item.nights) &&
        item.nights >= 0 &&
        validMoney(item.revenue, code) &&
        validMoney(item.adr, code),
    )
  );
}

const validMoney = (value: FinanceReportingMoney, currency: string) =>
  value.currency === currency && decimal(value.amount);
const decimal = (value: string) => /^-?(?:0|[1-9]\d*)\.\d{4}$/.test(value);
const ratio = (value: string) => /^(?:0|1)\.\d{4}$/.test(value) && Number(value) <= 1;
const label = (value: string) => value.trim() === value && value.length > 0 && value.length <= 200;
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
function zone(value: string): boolean {
  try {
    const timeZone = getTimezone(value);
    return timeZone?.name === value && timeZone.aliasOf === null;
  } catch {
    return false;
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
