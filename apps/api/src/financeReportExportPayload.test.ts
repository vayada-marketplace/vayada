import { createHash } from "node:crypto";
import {
  captureFinanceDashboardExport,
  captureFinanceRevenueExport,
  financeDashboardPeriods,
  financeReportingMoneyMetric,
  type FinanceDashboardResponse,
  type FinanceRevenueResponse,
} from "@vayada/domain-finance";
import type pg from "pg";
import { describe, expect, it } from "vitest";

import {
  createPgFinanceFolioExportJobRepository,
  parseFinanceExportJobPayload,
} from "./domains/financeFolioExportRepository.js";

const PROPERTY = "11340000-0000-4000-8000-000000000020";
const ORG = "11340000-0000-4000-8000-000000000022";
const COMMAND = "11340000-0000-4000-8000-000000000023";
const SNAPSHOT_AT = "2026-09-14T23:59:59.999Z";
const ACCEPTED = "2026-09-15T00:00:00.000Z";
const EXPIRES = "2026-09-16T00:00:00.000Z";
const money = (amount = "0.0000") => ({ amount, currency: "EUR" });
const metric = () => financeReportingMoneyMetric("0", "0", "EUR");
const envelope = () => ({
  contractVersion: "pms-financials.v1" as const,
  propertyId: PROPERTY,
  currency: "EUR",
  timeZone: "Europe/Berlin",
  generatedAt: SNAPSHOT_AT,
  sourceFreshness: {},
  incompleteEvidence: [],
});

function snapshots() {
  const revenue: FinanceRevenueResponse = {
    ...envelope(),
    summary: {
      grossRoom: metric(),
      otaCommission: metric(),
      netRoom: metric(),
      upsell: metric(),
      nights: { value: 0, absoluteChange: 0, percentChange: null },
      adr: metric(),
      attachRate: { value: "0.0000", absoluteChange: "0.0000", percentChange: null },
    },
    channels: [],
    directSources: [],
    upsells: [],
    roomTypes: [],
  };
  const range = financeDashboardPeriods("2026-09-15").daily;
  const start = Date.parse(`${range.from}T00:00:00Z`);
  const dashboard: FinanceDashboardResponse = {
    ...envelope(),
    cards: {
      revenueToday: metric(),
      revenueMtd: metric(),
      expensesMtd: metric(),
      profitMtd: metric(),
    },
    daily: Array.from({ length: 14 }, (_, index) => ({
      date: new Date(start + index * 86_400_000).toISOString().slice(0, 10),
      revenue: money(),
      expenses: money(),
    })),
    upcoming: [],
  };
  return [
    captureFinanceRevenueExport({
      propertyId: PROPERTY,
      response: revenue,
      query: { from: "2026-09-01", to: "2026-09-15" },
    }),
    captureFinanceDashboardExport({ propertyId: PROPERTY, response: dashboard, query: {} }),
  ] as const;
}

const reorder = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reorder)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, part]) => [key, reorder(part)]),
        )
      : value;

describe("Revenue and Dashboard export job payloads", () => {
  it("binds accepted scope and survives PostgreSQL JSONB key reordering", () => {
    for (const snapshot of snapshots()) {
      const payload = { commandId: COMMAND, organizationId: ORG, snapshot, expiresAt: EXPIRES };
      const expected = {
        organizationId: ORG,
        propertyId: PROPERTY,
        currency: "EUR",
        payloadFingerprint: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        acceptedAt: ACCEPTED,
        snapshotAt: SNAPSHOT_AT,
        expiresAt: EXPIRES,
        now: new Date("2026-09-15T01:00:00.000Z"),
      };
      expect(parseFinanceExportJobPayload(payload, expected)).toEqual(payload);
      expect(JSON.stringify(parseFinanceExportJobPayload(reorder(payload), expected))).toBe(
        JSON.stringify(payload),
      );
      expect(() => parseFinanceExportJobPayload(payload, { ...expected, propertyId: ORG })).toThrow(
        TypeError,
      );
      const corrupt = JSON.parse(JSON.stringify(payload));
      corrupt.snapshot.currency = "USD";
      expect(() => parseFinanceExportJobPayload(corrupt, expected)).toThrow(TypeError);
    }
  });

  it("normalizes an omitted Dashboard as-of before enqueue validation", async () => {
    const pool = {
      connect: () => {
        throw new Error("db reached");
      },
    } as unknown as pg.Pool;
    const repository = createPgFinanceFolioExportJobRepository({
      pool,
      searchDigest: async () => "d".repeat(64),
    });
    const command = {
      commandId: COMMAND,
      idempotencyKey: "dashboard-export-key",
      organizationId: ORG,
      propertyId: PROPERTY,
      currency: "EUR",
      filters: {},
      snapshot: snapshots()[1],
      envelope: envelope(),
      audit: {
        actorUserId: COMMAND,
        requestId: "dashboard-request",
        correlationId: "dashboard-request",
        causationId: COMMAND,
        requestedAt: ACCEPTED,
      },
    };
    await expect(repository.enqueue(command)).rejects.toThrow("db reached");
    await expect(
      repository.enqueue({ ...command, filters: { asOf: "2026-09-14" } }),
    ).rejects.toThrow(TypeError);
  });
});
