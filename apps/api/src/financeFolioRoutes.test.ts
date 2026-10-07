import { createHash } from "node:crypto";

import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
// prettier-ignore
import { captureFinanceProfitLossExport, financeDashboardPeriods, financeReportingMoneyMetric, type FinanceDashboardResponse, type FinanceExpenseExportSnapshot, type FinanceFolioDetailResponse, type FinanceFolioExportSnapshot, type FinanceFolioListResponse, type FinanceProfitLossResponse, type FinanceRevenueResponse } from "@vayada/domain-finance";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import { requestContextFixtureCases } from "./platform/requestContext.fixtures.js";
import {
  FinanceFolioCursorError,
  FinanceFolioEvidenceError,
} from "./domains/financeFolioReadRepository.js";
import { FinanceExpenseEvidenceError } from "./domains/financeExpenseReadModel.js";
import { FinanceProfitLossEvidenceError } from "./domains/financeProfitLossReadModel.js";
import type { FinanceFolioRoutesOptions } from "./routes/financeFolios.js";

const propertyId = "11320000-0000-4000-8000-000000000001";
const otherPropertyId = "11320000-0000-4000-8000-000000000002";
const folioId = "11320000-0000-4000-8000-000000000003";
const bookingId = "11320000-0000-4000-8000-000000000004";
const lineId = "11320000-0000-4000-8000-000000000005";
const paymentId = "11320000-0000-4000-8000-000000000006";
const exportId = "11320000-0000-4000-8000-000000000012";
const correctCommandId = "11320000-0000-4000-8000-000000000007";
const readyCommandId = "11320000-0000-4000-8000-000000000008";
const archiveCommandId = "11320000-0000-4000-8000-000000000009";
const now = "2026-08-21T10:00:00.000Z";
const exportExpiresAt = "2026-08-21T10:01:00.000Z";
const root = `/api/finance/properties/${propertyId}/financials/folios`;
const exportRoot = `/api/finance/properties/${propertyId}/financials/exports`;
const money = { amount: "12.0000", currency: "EUR" };
const base = {
  contractVersion: "pms-financials.v1" as const,
  propertyId,
  currency: "EUR",
  timeZone: "Europe/Berlin",
  generatedAt: now,
  sourceFreshness: { financeFolios: now },
  incompleteEvidence: [],
};
const summary = {
  folioId,
  bookingId,
  revision: 2,
  state: "ready" as const,
  serviceFrom: "2026-08-20",
  serviceTo: "2026-08-21",
  total: money,
  createdAt: now,
};
const list: FinanceFolioListResponse = {
  ...base,
  page: { items: [summary], nextCursor: null, limit: 1 },
};
// prettier-ignore
const detail: FinanceFolioDetailResponse = { ...base, item: { ...summary, propertyId, recipient: { name: "Ada Lovelace", email: "ada@example.com" }, currency: "EUR", lines: [{ lineId, position: 1, kind: "room", description: "Stay", quantity: "1.0000", unitAmount: money, total: money, serviceOn: "2026-08-20", source: { type: "booking_night", id: bookingId, revision: 3 } }], paymentRefs: [{ paymentId, amount: money }], sourceDigest: "a".repeat(64), sourceFreshness: { booking: now } } };
// prettier-ignore
const exportSnapshot: FinanceFolioExportSnapshot = { formatVersion: "pms-financials-folios.v1", propertyId, currency: "EUR", filters: { state: "ready", sort: "createdAt_desc" }, snapshotAt: now, manifest: [{ folioId, revisionId: readyCommandId, revision: 2, sourceDigest: "a".repeat(64) }] };
const exportCapture = { envelope: base, snapshot: exportSnapshot };
// prettier-ignore
const exportBody = { commandId: folioId, idempotencyKey: "folio-export", tab: "folios", format: "csv", filters: { state: "ready", sort: "createdAt_desc" } };
// prettier-ignore
const expenseSnapshot: FinanceExpenseExportSnapshot = { formatVersion: "pms-financials-expenses.v1", propertyId, currency: "EUR", filters: { from: "2026-08-01", to: "2026-08-31", paymentStatus: "unpaid", sort: "incurredOn_desc" }, snapshotAt: now, manifest: [{ expenseId: bookingId, revision: 2, categoryId: lineId, categoryRevision: 1, categoryName: "Utilities", paymentStatus: "unpaid", paidOn: null }] };
const expenseCapture = {
  envelope: { ...base, sourceFreshness: { financeExpenses: now } },
  snapshot: expenseSnapshot,
};
// prettier-ignore
const expenseBody = { commandId: bookingId, idempotencyKey: "expense-export", tab: "expenses", format: "csv", filters: expenseSnapshot.filters };
const zero = () => ({ amount: "0.0000", currency: "EUR" });
const profitLossResponse: FinanceProfitLossResponse = {
  ...base,
  sourceFreshness: { financeProfitLoss: now },
  incompleteEvidence: [
    { code: "expense_currency_mismatch", count: 1, amount: { amount: "99.0000", currency: "USD" } },
    { code: "room_currency_unknown", count: 1, currency: "USD" },
  ],
  summary: {
    revenueYtd: financeReportingMoneyMetric("0", "0", "EUR"),
    expensesYtd: financeReportingMoneyMetric("0", "0", "EUR"),
    netProfitYtd: financeReportingMoneyMetric("0", "0", "EUR"),
  },
  months: Array.from({ length: 8 }, (_, index) => ({
    month: `2026-${String(index + 1).padStart(2, "0")}`,
    roomRevenue: zero(),
    upsellRevenue: zero(),
    revenue: zero(),
    expenses: zero(),
    netProfit: zero(),
    expenseCategories: Object.fromEntries(
      ["ota_commission", "staff", "utilities", "maintenance_supplies", "marketing_platform"].map(
        (key) => [key, zero()],
      ),
    ) as FinanceProfitLossResponse["months"][number]["expenseCategories"],
  })),
};
const profitLossEnvelope = (({
  contractVersion,
  propertyId,
  currency,
  timeZone,
  generatedAt,
  sourceFreshness,
  incompleteEvidence,
}) => ({
  contractVersion,
  propertyId,
  currency,
  timeZone,
  generatedAt,
  sourceFreshness,
  incompleteEvidence,
}))(profitLossResponse);
const profitLossSnapshot = captureFinanceProfitLossExport({
  propertyId,
  response: profitLossResponse,
  query: { year: 2026 },
  asOf: "2026-08-21",
  categoryRows: [],
});
const profitLossBody = {
  commandId: paymentId,
  idempotencyKey: "profit-loss-export",
  tab: "profit-loss",
  format: "csv",
  filters: { year: 2026 },
};
const revenueResponse: FinanceRevenueResponse = {
  ...base,
  summary: {
    grossRoom: financeReportingMoneyMetric("0", "0", "EUR"),
    otaCommission: financeReportingMoneyMetric("0", "0", "EUR"),
    netRoom: financeReportingMoneyMetric("0", "0", "EUR"),
    upsell: financeReportingMoneyMetric("0", "0", "EUR"),
    nights: { value: 0, absoluteChange: 0, percentChange: null },
    adr: financeReportingMoneyMetric("0", "0", "EUR"),
    attachRate: { value: "0.0000", absoluteChange: "0.0000", percentChange: null },
  },
  channels: [],
  directSources: [],
  upsells: [],
  roomTypes: [],
};
const dashboardDaily = financeDashboardPeriods("2026-08-21").daily;
const dashboardStart = Date.parse(`${dashboardDaily.from}T00:00:00Z`);
const dashboardResponse: FinanceDashboardResponse = {
  ...base,
  cards: {
    revenueToday: financeReportingMoneyMetric("0", "0", "EUR"),
    revenueMtd: financeReportingMoneyMetric("0", "0", "EUR"),
    expensesMtd: financeReportingMoneyMetric("0", "0", "EUR"),
    profitMtd: financeReportingMoneyMetric("0", "0", "EUR"),
  },
  daily: Array.from({ length: 14 }, (_, index) => ({
    date: new Date(dashboardStart + index * 86_400_000).toISOString().slice(0, 10),
    revenue: zero(),
    expenses: zero(),
  })),
  upcoming: [],
};
const revenueBody = {
  commandId: folioId,
  idempotencyKey: "revenue-export",
  tab: "revenue",
  format: "csv",
  filters: { from: "2026-08-01", to: "2026-08-21" },
};
const dashboardBody = {
  commandId: bookingId,
  idempotencyKey: "dashboard-export",
  tab: "dashboard",
  format: "csv",
  filters: {},
};

type Ports = FinanceFolioRoutesOptions["repository"] & {
  list: ReturnType<typeof vi.fn>;
  detail: ReturnType<typeof vi.fn>;
  captureReadyExport: ReturnType<typeof vi.fn>;
  exportReady: ReturnType<typeof vi.fn>;
};
type Commands = NonNullable<FinanceFolioRoutesOptions["commands"]> & {
  create: ReturnType<typeof vi.fn>;
  correct: ReturnType<typeof vi.fn>;
  ready: ReturnType<typeof vi.fn>;
  archive: ReturnType<typeof vi.fn>;
};
// prettier-ignore
type ExportJobs = NonNullable<FinanceFolioRoutesOptions["exports"]> & { enqueue: ReturnType<typeof vi.fn> };
type StreamJobs = ExportJobs & { recordStream: ReturnType<typeof vi.fn> };
type ExportDownloads = NonNullable<FinanceFolioRoutesOptions["exportDownloads"]> & {
  read: { find: ReturnType<typeof vi.fn> };
  signer: { signPrivateDownload: ReturnType<typeof vi.fn> };
  now: ReturnType<typeof vi.fn>;
};
type ExpenseExports = NonNullable<FinanceFolioRoutesOptions["expenseExports"]> & {
  captureExport: ReturnType<typeof vi.fn>;
  exportCsv: ReturnType<typeof vi.fn>;
};
type ProfitLossExports = NonNullable<FinanceFolioRoutesOptions["profitLossExports"]> & {
  profitLoss: ReturnType<typeof vi.fn>;
};
type RevenueExports = NonNullable<FinanceFolioRoutesOptions["revenueExports"]> & {
  revenue: ReturnType<typeof vi.fn>;
};
type DashboardExports = NonNullable<FinanceFolioRoutesOptions["dashboardExports"]> & {
  dashboard: ReturnType<typeof vi.fn>;
};
const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function ports(): Ports {
  return {
    list: vi.fn(async () => list),
    detail: vi.fn(async () => detail),
    captureReadyExport: vi.fn(async () => exportCapture),
    exportReady: vi.fn(async () => ({
      formatVersion: "pms-financials-folios.v1",
      propertyId,
      currency: "EUR",
      contentType: "text/csv; charset=utf-8",
      filename: `pms-financials-folios-${propertyId}.csv`,
      rowCount: 1,
      body: "folio_id\r\nfolio-1\r\n",
    })),
  } as Ports;
}

function commands(): Commands {
  return {
    create: vi.fn(async () => ({ status: "created", folioId, revision: 1 })),
    correct: vi.fn(async () => ({ status: "updated", folioId, revision: 2 })),
    ready: vi.fn(async () => ({ status: "updated", folioId, revision: 3 })),
    archive: vi.fn(async () => ({ status: "replayed", folioId, revision: 4 })),
  } as Commands;
}

// prettier-ignore
function exportJobs(): ExportJobs { return { enqueue: vi.fn(async () => ({ status: "created", exportId, envelope: exportCapture.envelope })) } as ExportJobs; }
function streamJobs(): StreamJobs {
  const jobs = exportJobs();
  return { ...jobs, recordStream: vi.fn(async () => undefined) } as StreamJobs;
}
// prettier-ignore
function exportDownloads(): ExportDownloads { return { read:{find:vi.fn(async()=>({state:"ready",expiresAt:exportExpiresAt,artifact:{mediaId:exportId,bucketName:"test-private",storageKey:`private/finance/financials-exports/${exportId}/pms-financials-folios.v1.csv`,visibility:"private",lifecycleStatus:"active",filename:`pms-financials-folios-${propertyId}.csv`,contentType:"text/csv; charset=utf-8",sizeBytes:42}}))},signer:{signPrivateDownload:vi.fn(async()=>"https://signed.example/folio.csv")},serving:{bucketName:"test-private",cdnBaseUrl:"https://cdn.example",cdnOriginHost:"origin.example",publicPathPrefix:"media",publicCacheControl:"public, max-age=31536000, immutable",privateDownloadTtlSeconds:300,privateDownloadMaxTtlSeconds:900},now:vi.fn(()=>new Date(now))} as ExportDownloads; }
// prettier-ignore
function expenseExports(): ExpenseExports { return { captureExport: vi.fn(async () => expenseCapture), exportCsv: vi.fn(async () => ({ formatVersion: "pms-financials-expenses.v1", propertyId, currency: "EUR", contentType: "text/csv; charset=utf-8", filename: `pms-financials-expenses-${propertyId}.csv`, rowCount: 1, body: "expense_id\r\nexpense-1\r\n", auditEvidence: expenseSnapshot.manifest })) } as ExpenseExports; }
function profitLossExports(): ProfitLossExports {
  return {
    profitLoss: vi.fn(async () => ({ response: profitLossResponse, categoryRows: [] })),
  } as ProfitLossExports;
}
const revenueExports = (): RevenueExports =>
  ({ revenue: vi.fn(async () => revenueResponse) }) as RevenueExports;
const dashboardExports = (): DashboardExports =>
  ({ dashboard: vi.fn(async () => dashboardResponse) }) as DashboardExports;

// prettier-ignore
async function app(repository: Ports, auth: RequestContext | null = context(), write?: Commands, exports?: ExportJobs, exportDownloads?: ExportDownloads, expenses?: ExpenseExports, profitLoss?: ProfitLossExports, revenue?: RevenueExports, dashboard?: DashboardExports) {
  const instance = buildApp({
    logger: false,
    browserAllowedOrigins: ["https://pms.example"],
    financeFolios: {
      repository,
      propertyAccessRepository: agencyPropertyAccessRepository,
      ...(write ? { commands: write } : {}),
      ...(exports ? { exports } : {}),
      ...(exportDownloads ? { exportDownloads } : {}),
      ...(expenses ? { expenseExports: expenses } : {}),
      ...(profitLoss ? { profitLossExports: profitLoss } : {}),
      ...(revenue ? { revenueExports: revenue } : {}),
      ...(dashboard ? { dashboardExports: dashboard } : {}),
    },
  });
  instance.decorateRequest("authContext", null);
  instance.addHook("onRequest", async (request) => {
    request.authContext = auth;
  });
  apps.push(instance);
  return instance;
}

describe("Financials folio read routes", () => {
  it("denies unassigned folio reads and commands before ports", async () => {
    const auth = context({ permissions: ["pms.finance.read", "pms.finance.manage"] });
    auth.membership.propertyAccess!.assignedPropertyIds = [];
    const repository = ports(),
      write = commands();
    const instance = await app(repository, auth, write);
    for (const method of ["GET", "POST"] as const) {
      const response = await instance.inject({
        method,
        url: root,
        ...(method === "POST" ? { payload: writeBody() } : {}),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: "forbidden" });
    }
    expect(repository.list).not.toHaveBeenCalled();
    expect(write.create).not.toHaveBeenCalled();
  });

  it("registers list and detail with canonical query, IDs, and response shapes", async () => {
    const repository = ports();
    const instance = await app(repository);
    const listed = await instance.inject({
      method: "GET",
      url: `${root}?from=2026-08-01&to=2026-08-31&state=ready&search=Guest&sort=amount_desc&limit=1`,
      headers: { origin: "https://pms.example" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(list);
    expect(listed.headers).toMatchObject({
      "cache-control": "private, no-store",
      vary: "Origin, Authorization",
      "access-control-allow-origin": "https://pms.example",
    });
    expect(repository.list).toHaveBeenCalledWith(propertyId, {
      from: "2026-08-01",
      to: "2026-08-31",
      state: "ready",
      search: "Guest",
      sort: "amount_desc",
      limit: 1,
    });

    const read = await instance.inject({ method: "GET", url: `${root}/${folioId.toUpperCase()}` });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(detail);
    expect(repository.detail).toHaveBeenCalledWith(propertyId, folioId);

    repository.detail.mockResolvedValueOnce({
      ...detail,
      providerSecret: "must-not-leak",
      item: { ...detail.item, recipient: { ...detail.item.recipient, taxId: "must-not-leak" } },
    });
    const invalid = await instance.inject({ method: "GET", url: `${root}/${folioId}` });
    expect(invalid.statusCode).toBe(500);
    expect(JSON.stringify(invalid.json())).not.toContain("must-not-leak");

    // prettier-ignore
    for (const page of [{ ...list.page, items: [{ ...summary, total: { ...money, amount: "12" } }] }, { ...list.page, items: [{ ...summary, total: { ...money, currency: "USD" } }] }, { ...list.page, items: [{ ...summary, createdAt: "2026-02-31T00:00:00.000Z" }] }, { ...list.page, nextCursor: "not valid" }, { ...list.page, nextCursor: Buffer.from(JSON.stringify({ v: 1, q: [otherPropertyId, "EUR", null, null, null, null, "createdAt_desc"], p: [now, folioId] })).toString("base64url") }]) { repository.list.mockResolvedValueOnce({ ...list, page } as never); expect(await instance.inject({ method: "GET", url: root })).toHaveProperty("statusCode", 500); }
    repository.list.mockResolvedValueOnce({ ...list, timeZone: "Etc/UTC" });
    expect(await instance.inject({ method: "GET", url: root })).toHaveProperty("statusCode", 200);
  });

  it("enforces the complete read denial matrix before validation or ports", async () => {
    const allowed = context();
    // prettier-ignore
    const denied: Array<[RequestContext | null, number]> = [[null, 401], [context({ permissions: [] }), 403], [context({ kind: "platform" }), 403], [context({ entitlements: [] }), 403], [context({ entitlements: [entitlement("property-management")] }), 403], [context({ entitlements: [entitlement("property-management", "suspended"), entitlement("module:financials")] }), 403], [context({ entitlements: [entitlement("property-management"), entitlement("module:financials", "suspended")] }), 403], [context({ links: [] }), 403], [context({ links: [{ ...allowed.linkedResources[0]!, status: "suspended" }] }), 403], [context({ links: [{ ...allowed.linkedResources[0]!, relationship: "operator" }] }), 403], [context({ links: [{ ...allowed.linkedResources[0]!, resourceId: otherPropertyId }] }), 403]];
    for (const [auth, status] of denied) {
      const repository = ports();
      const instance = await app(repository, auth);
      const response = await instance.inject({
        method: "GET",
        url: `${root}?private=1`,
      });
      expect(response.statusCode).toBe(status);
      expect(repository.list).not.toHaveBeenCalled();
    }

    const financeManager = ports();
    const instance = await app(
      financeManager,
      context({
        links: allowed.linkedResources.map((link) => ({
          ...link,
          relationship: "finance_manager",
        })),
      }),
    );
    expect(await instance.inject({ method: "GET", url: root })).toHaveProperty("statusCode", 200);
  });

  it("validates authorized inputs and maps missing or typed repository outcomes", async () => {
    const repository = ports();
    const instance = await app(repository);
    expect(await instance.inject({ method: "GET", url: `${root}?unknown=1` })).toHaveProperty(
      "statusCode",
      400,
    );
    expect(await instance.inject({ method: "GET", url: `${root}/not-a-uuid` })).toHaveProperty(
      "statusCode",
      400,
    );
    expect(repository.list).not.toHaveBeenCalled();
    expect(repository.detail).not.toHaveBeenCalled();

    repository.detail.mockResolvedValueOnce(null);
    expect(await instance.inject({ method: "GET", url: `${root}/${folioId}` })).toHaveProperty(
      "statusCode",
      404,
    );
    repository.list.mockRejectedValueOnce(new FinanceFolioCursorError("private"));
    expect((await instance.inject({ method: "GET", url: root })).json()).toEqual({
      code: "invalid_cursor",
    });
    repository.list.mockRejectedValueOnce(new FinanceFolioEvidenceError("private"));
    expect(await instance.inject({ method: "GET", url: root })).toMatchObject({ statusCode: 422 });
    repository.list.mockRejectedValueOnce(new Error("secret"));
    expect((await instance.inject({ method: "GET", url: root })).json()).toEqual({
      code: "finance_folio_port_contract_violation",
    });
  });

  it("fails closed on a cross-property repository response", async () => {
    const repository = ports();
    repository.list.mockResolvedValueOnce({ ...list, propertyId: otherPropertyId });
    const instance = await app(repository);
    const response = await instance.inject({ method: "GET", url: root });
    expect(response).toMatchObject({ statusCode: 500 });
    expect(response.json()).toEqual({ code: "finance_folio_port_contract_violation" });
  });
});

describe("Financials folio export route", () => {
  it("captures a ready snapshot and enqueues an authenticated property-scoped export", async () => {
    const repository = ports(),
      jobs = exportJobs();
    const instance = await app(repository, context(), undefined, jobs);
    // prettier-ignore
    const response = await instance.inject({ method: "POST", url: exportRoot, headers: { "idempotency-key": exportBody.idempotencyKey }, payload: exportBody });
    expect(response.statusCode).toBe(202);
    // prettier-ignore
    expect(response.json()).toEqual({ ...exportCapture.envelope, item: { resourceId: exportId, state: "pending" }, outcome: "created" });
    expect(repository.captureReadyExport).toHaveBeenCalledWith(propertyId, exportBody.filters);
    expect(jobs.enqueue).toHaveBeenCalledWith({
      commandId: exportBody.commandId,
      idempotencyKey: exportBody.idempotencyKey,
      filters: exportBody.filters,
      organizationId: "11320000-0000-4000-8000-000000000011",
      propertyId,
      currency: "EUR",
      snapshot: exportSnapshot,
      envelope: exportCapture.envelope,
      audit: {
        actorUserId: "11320000-0000-4000-8000-000000000010",
        requestId: "request-1",
        correlationId: "request-1",
        causationId: folioId,
        requestedAt: now,
      },
    });

    // prettier-ignore
    repository.captureReadyExport.mockResolvedValueOnce({ envelope: { ...exportCapture.envelope, currency: "USD" }, snapshot: { ...exportSnapshot, currency: "USD" } });
    // prettier-ignore
    jobs.enqueue.mockResolvedValueOnce({ status: "replayed", exportId, envelope: exportCapture.envelope });
    const replay = await instance.inject({ method: "POST", url: exportRoot, payload: exportBody });
    expect(replay).toMatchObject({ statusCode: 200 });
    expect(replay.json().currency).toBe("EUR");
    expect(jobs.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ currency: "USD" }));
    jobs.enqueue.mockResolvedValueOnce({ status: "conflict" });
    // prettier-ignore
    expect(await instance.inject({ method: "POST", url: exportRoot, payload: exportBody })).toMatchObject({ statusCode: 409 });
    jobs.enqueue.mockResolvedValueOnce({
      status: "replayed",
      exportId,
      envelope: { ...exportCapture.envelope, secret: "must-not-leak" },
    } as never);
    const invalid = await instance.inject({ method: "POST", url: exportRoot, payload: exportBody });
    expect(invalid.statusCode).toBe(500);
    expect(JSON.stringify(invalid.json())).not.toContain("must-not-leak");
  });

  it("captures and enqueues the expenses tab through the canonical export route", async () => {
    const repository = ports(),
      jobs = exportJobs(),
      expenses = expenseExports();
    jobs.enqueue.mockResolvedValueOnce({
      status: "created",
      exportId,
      envelope: expenseCapture.envelope,
    });
    const instance = await app(repository, context(), undefined, jobs, undefined, expenses);
    const response = await instance.inject({
      method: "POST",
      url: exportRoot,
      payload: expenseBody,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      ...expenseCapture.envelope,
      item: { resourceId: exportId, state: "pending" },
      outcome: "created",
    });
    expect(expenses.captureExport).toHaveBeenCalledWith(propertyId, expenseBody.filters);
    expect(repository.captureReadyExport).not.toHaveBeenCalled();
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: expenseBody.commandId,
        idempotencyKey: expenseBody.idempotencyKey,
        filters: expenseBody.filters,
        organizationId: "11320000-0000-4000-8000-000000000011",
        propertyId,
        currency: "EUR",
        snapshot: expenseSnapshot,
        envelope: expenseCapture.envelope,
      }),
    );

    expenses.captureExport.mockRejectedValueOnce(new FinanceExpenseEvidenceError("private"));
    expect(
      await instance.inject({ method: "POST", url: exportRoot, payload: expenseBody }),
    ).toMatchObject({ statusCode: 422 });
    const malformed = await instance.inject({
      method: "POST",
      url: exportRoot,
      payload: { ...expenseBody, filters: { ...expenseBody.filters, limit: 1 } },
    });
    expect(malformed).toMatchObject({ statusCode: 400 });
    expect(JSON.stringify(malformed.json())).not.toContain("private");
    expect(expenses.captureExport).toHaveBeenCalledTimes(2);
  });

  it("captures a property-scoped P&L read and enqueues its pinned CSV snapshot", async () => {
    const repository = ports(),
      jobs = exportJobs(),
      profitLoss = profitLossExports();
    jobs.enqueue.mockResolvedValue({ status: "created", exportId, envelope: profitLossEnvelope });
    const instance = await app(
      repository,
      context(),
      undefined,
      jobs,
      undefined,
      undefined,
      profitLoss,
    );
    const response = await instance.inject({
      method: "POST",
      url: exportRoot,
      payload: profitLossBody,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      ...profitLossEnvelope,
      item: { resourceId: exportId, state: "pending" },
      outcome: "created",
    });
    expect(profitLoss.profitLoss).toHaveBeenCalledWith(propertyId, { year: 2026 });
    expect(repository.captureReadyExport).not.toHaveBeenCalled();
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId,
        currency: "EUR",
        filters: { year: 2026 },
        snapshot: profitLossSnapshot,
        envelope: profitLossEnvelope,
      }),
    );
    expect(
      await instance.inject({
        method: "POST",
        url: exportRoot,
        payload: { ...profitLossBody, filters: { year: 2026, extra: true } },
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(profitLoss.profitLoss).toHaveBeenCalledTimes(1);
    profitLoss.profitLoss.mockResolvedValueOnce({
      response: { ...profitLossResponse, propertyId: otherPropertyId },
      categoryRows: [],
    });
    expect(
      await instance.inject({ method: "POST", url: exportRoot, payload: profitLossBody }),
    ).toMatchObject({ statusCode: 500 });
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    profitLoss.profitLoss.mockRejectedValueOnce(new FinanceProfitLossEvidenceError("private"));
    const unavailable = await instance.inject({
      method: "POST",
      url: exportRoot,
      payload: profitLossBody,
    });
    expect(unavailable).toMatchObject({ statusCode: 422 });
    expect(JSON.stringify(unavailable.json())).not.toContain("private");
  });

  it("accepts only the scoped private P&L artifact on status lookup", async () => {
    const access = exportDownloads();
    access.read.find.mockResolvedValue({
      state: "ready",
      expiresAt: exportExpiresAt,
      artifact: {
        mediaId: exportId,
        bucketName: "test-private",
        storageKey: `private/finance/financials-exports/${exportId}/pms-financials-profit-loss.v1.csv`,
        visibility: "private",
        lifecycleStatus: "active",
        filename: `pms-financials-profit-loss-${propertyId}-2026-2026-08-21.csv`,
        contentType: "text/csv; charset=utf-8",
        sizeBytes: 42,
      },
    });
    const instance = await app(ports(), context(), undefined, undefined, access);
    expect(
      (await instance.inject({ method: "GET", url: `${exportRoot}/${exportId}` })).statusCode,
    ).toBe(200);
    access.read.find.mockResolvedValueOnce({
      state: "ready",
      expiresAt: exportExpiresAt,
      artifact: {
        mediaId: exportId,
        bucketName: "test-private",
        storageKey: `private/finance/financials-exports/${exportId}/pms-financials-profit-loss.v1.csv`,
        visibility: "private",
        lifecycleStatus: "active",
        filename: `pms-financials-profit-loss-${otherPropertyId}-2026-2026-08-21.csv`,
        contentType: "text/csv; charset=utf-8",
        sizeBytes: 42,
      },
    });
    expect(
      (await instance.inject({ method: "GET", url: `${exportRoot}/${exportId}` })).statusCode,
    ).toBe(500);
  });

  it("captures scoped Revenue and Dashboard reads with pinned export filters", async () => {
    const repository = ports(),
      jobs = exportJobs(),
      revenue = revenueExports(),
      dashboard = dashboardExports();
    jobs.enqueue.mockImplementation(async (command) => ({
      status: "created",
      exportId,
      envelope: command.envelope,
    }));
    const instance = await app(
      repository,
      context(),
      undefined,
      jobs,
      undefined,
      undefined,
      undefined,
      revenue,
      dashboard,
    );
    for (const body of [revenueBody, dashboardBody]) {
      const response = await instance.inject({ method: "POST", url: exportRoot, payload: body });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        propertyId,
        item: { resourceId: exportId, state: "pending" },
      });
    }
    expect(revenue.revenue).toHaveBeenCalledWith(propertyId, revenueBody.filters);
    expect(dashboard.dashboard).toHaveBeenCalledWith(propertyId, {});
    expect(jobs.enqueue.mock.calls[0]![0]).toMatchObject({
      propertyId,
      filters: revenueBody.filters,
      snapshot: { formatVersion: "pms-financials-revenue.v1" },
    });
    expect(jobs.enqueue.mock.calls[1]![0]).toMatchObject({
      propertyId,
      filters: { asOf: "2026-08-21" },
      snapshot: { formatVersion: "pms-financials-dashboard.v1", asOf: "2026-08-21" },
    });
    expect(repository.captureReadyExport).not.toHaveBeenCalled();
    expect(
      await instance.inject({
        method: "POST",
        url: exportRoot,
        payload: { ...revenueBody, filters: { ...revenueBody.filters, extra: true } },
      }),
    ).toMatchObject({ statusCode: 400 });
    revenue.revenue.mockResolvedValueOnce({ ...revenueResponse, propertyId: otherPropertyId });
    expect(
      await instance.inject({ method: "POST", url: exportRoot, payload: revenueBody }),
    ).toMatchObject({ statusCode: 500 });
    expect(jobs.enqueue).toHaveBeenCalledTimes(2);
    revenue.revenue.mockResolvedValueOnce({
      ...revenueResponse,
      generatedAt: "2026-08-21T10:00:00Z",
    });
    expect(
      await instance.inject({ method: "POST", url: exportRoot, payload: revenueBody }),
    ).toMatchObject({ statusCode: 202 });
    expect(jobs.enqueue).toHaveBeenCalledTimes(3);
  });

  it("accepts only property-scoped Revenue and Dashboard private artifacts", async () => {
    const access = exportDownloads();
    const instance = await app(ports(), context(), undefined, undefined, access);
    for (const [version, filename] of [
      [
        "pms-financials-revenue.v1",
        `pms-financials-revenue-${propertyId}-2026-08-01-2026-08-21.csv`,
      ],
      ["pms-financials-dashboard.v1", `pms-financials-dashboard-${propertyId}-2026-08-21.csv`],
    ]) {
      access.read.find.mockResolvedValueOnce({
        state: "ready",
        expiresAt: exportExpiresAt,
        artifact: {
          mediaId: exportId,
          bucketName: "test-private",
          storageKey: `private/finance/financials-exports/${exportId}/${version}.csv`,
          visibility: "private",
          lifecycleStatus: "active",
          filename,
          contentType: "text/csv; charset=utf-8",
          sizeBytes: 42,
        },
      });
      expect(
        (await instance.inject({ method: "GET", url: `${exportRoot}/${exportId}` })).statusCode,
      ).toBe(200);
    }
  });

  it("fails closed before snapshot capture for malformed requests or unauthorized callers", async () => {
    const repository = ports(),
      jobs = exportJobs();
    let instance = await app(repository, context(), undefined, jobs);
    // prettier-ignore
    expect(await instance.inject({ method: "POST", url: exportRoot, headers: { "idempotency-key": "different" }, payload: exportBody })).toMatchObject({ statusCode: 400 });
    expect(repository.captureReadyExport).not.toHaveBeenCalled();

    // prettier-ignore
    repository.captureReadyExport.mockResolvedValueOnce({ envelope: { ...exportCapture.envelope, propertyId: bookingId }, snapshot: exportSnapshot });
    // prettier-ignore
    expect(await instance.inject({ method: "POST", url: exportRoot, payload: exportBody })).toMatchObject({ statusCode: 500 });
    expect(jobs.enqueue).not.toHaveBeenCalled();

    instance = await app(ports(), context({ permissions: [] }), undefined, exportJobs());
    expect(
      await instance.inject({ method: "POST", url: exportRoot, payload: { private: true } }),
    ).toMatchObject({ statusCode: 403 });
  });

  it("returns scoped export status and a retention-capped private download", async () => {
    const access = exportDownloads(),
      instance = await app(ports(), context(), undefined, undefined, access);
    const response = await instance.inject({
      method: "GET",
      url: `${exportRoot}/${exportId.toUpperCase()}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      contractVersion: "pms-financials-export.v1",
      propertyId,
      item: {
        resourceId: exportId,
        state: "ready",
        expiresAt: exportExpiresAt,
        artifact: {
          mediaId: exportId,
          filename: `pms-financials-folios-${propertyId}.csv`,
          contentType: "text/csv; charset=utf-8",
          sizeBytes: 42,
        },
        download: {
          method: "GET",
          url: "https://signed.example/folio.csv",
          expiresAt: exportExpiresAt,
        },
      },
    });
    expect(access.read.find).toHaveBeenCalledWith({
      exportId,
      organizationId: "11320000-0000-4000-8000-000000000011",
      propertyId,
      now: new Date(now),
    });
    expect(access.signer.signPrivateDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketName: "test-private",
        method: "GET",
        expiresInSeconds: 60,
        cacheControl: "private, no-store",
        responseContentDisposition: `attachment; filename="pms-financials-folios-${propertyId}.csv"`,
        responseContentType: "text/csv; charset=utf-8",
      }),
    );

    for (const state of ["pending", "running", "failed", "expired"] as const) {
      access.read.find.mockResolvedValueOnce({ state, expiresAt: exportExpiresAt });
      const status = await instance.inject({ method: "GET", url: `${exportRoot}/${exportId}` });
      expect(status.json()).toEqual({
        contractVersion: "pms-financials-export.v1",
        propertyId,
        item: { resourceId: exportId, state, expiresAt: exportExpiresAt },
      });
    }
    expect(access.signer.signPrivateDownload).toHaveBeenCalledTimes(1);
    access.read.find.mockResolvedValueOnce(null);
    expect(
      await instance.inject({ method: "GET", url: `${exportRoot}/${exportId}` }),
    ).toMatchObject({ statusCode: 404 });

    const late = exportDownloads();
    late.now.mockReturnValueOnce(new Date(now)).mockReturnValueOnce(new Date(exportExpiresAt));
    const lateResponse = await (
      await app(ports(), context(), undefined, undefined, late)
    ).inject({ method: "GET", url: `${exportRoot}/${exportId}` });
    expect(lateResponse.json()).toEqual({
      contractVersion: "pms-financials-export.v1",
      propertyId,
      item: { resourceId: exportId, state: "expired", expiresAt: exportExpiresAt },
    });
    expect(late.signer.signPrivateDownload).not.toHaveBeenCalled();
  });

  it("returns the exact private expense export artifact", async () => {
    const access = exportDownloads();
    access.read.find.mockResolvedValueOnce({
      state: "ready",
      expiresAt: exportExpiresAt,
      artifact: {
        mediaId: exportId,
        bucketName: "test-private",
        storageKey: `private/finance/financials-exports/${exportId}/pms-financials-expenses.v1.csv`,
        visibility: "private",
        lifecycleStatus: "active",
        filename: `pms-financials-expenses-${propertyId}.csv`,
        contentType: "text/csv; charset=utf-8",
        sizeBytes: 84,
      },
    });
    const response = await (
      await app(ports(), context(), undefined, undefined, access)
    ).inject({ method: "GET", url: `${exportRoot}/${exportId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().item.artifact).toEqual({
      mediaId: exportId,
      filename: `pms-financials-expenses-${propertyId}.csv`,
      contentType: "text/csv; charset=utf-8",
      sizeBytes: 84,
    });
    expect(access.signer.signPrivateDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        responseContentDisposition: `attachment; filename="pms-financials-expenses-${propertyId}.csv"`,
      }),
    );
  });

  it("authorizes status before lookup and rejects unsafe download evidence", async () => {
    const denied = exportDownloads(),
      unauthorized = await app(ports(), context({ permissions: [] }), undefined, undefined, denied);
    expect(
      await unauthorized.inject({ method: "GET", url: `${exportRoot}/private` }),
    ).toMatchObject({ statusCode: 403 });
    expect(denied.read.find).not.toHaveBeenCalled();
    const access = exportDownloads(),
      instance = await app(ports(), context(), undefined, undefined, access);
    access.signer.signPrivateDownload.mockResolvedValueOnce("http://must-not-leak.example/file");
    const unsafe = await instance.inject({ method: "GET", url: `${exportRoot}/${exportId}` });
    expect(unsafe.statusCode).toBe(500);
    expect(JSON.stringify(unsafe.json())).not.toContain("must-not-leak");
    access.read.find.mockResolvedValueOnce({
      state: "ready",
      expiresAt: exportExpiresAt,
      artifact: {
        mediaId: exportId,
        bucketName: "test-private",
        storageKey: "private/must-not-leak.csv",
        visibility: "private",
        lifecycleStatus: "active",
        filename: "must-not-leak.csv",
        contentType: "text/csv; charset=utf-8",
        sizeBytes: 42,
      },
    });
    const invalid = await instance.inject({ method: "GET", url: `${exportRoot}/${exportId}` });
    expect(invalid.statusCode).toBe(500);
    expect(JSON.stringify(invalid.json())).not.toContain("must-not-leak");
  });
});

describe("Financials opt-in auto export route", () => {
  it("streams each small captured tab with private headers and a completed audit", async () => {
    const repository = ports();
    const expenses = expenseExports();
    const jobs = streamJobs();
    const instance = await app(
      repository,
      context(),
      undefined,
      jobs,
      undefined,
      expenses,
      profitLossExports(),
      revenueExports(),
      dashboardExports(),
    );
    for (const body of [exportBody, expenseBody, profitLossBody, revenueBody, dashboardBody]) {
      const response = await instance.inject({
        method: "POST",
        url: `${exportRoot}/auto`,
        headers: { "idempotency-key": body.idempotencyKey },
        payload: body,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
      expect(response.headers["content-disposition"]).toMatch(
        /^attachment; filename="pms-financials-[a-z-]+-.*\.csv"$/,
      );
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.body.length).toBeGreaterThan(0);
      const [command, artifact] = jobs.recordStream.mock.lastCall!;
      expect(command.propertyId).toBe(propertyId);
      expect(artifact).toEqual({
        formatVersion: command.snapshot.formatVersion,
        rowCount: expect.any(Number),
        sizeBytes: Buffer.byteLength(response.body, "utf8"),
        checksumSha256: createHash("sha256").update(response.body).digest("hex"),
      });
    }
    expect(
      (await instance.inject({ method: "POST", url: `${exportRoot}/auto`, payload: exportBody }))
        .statusCode,
    ).toBe(200);
    expect(jobs.recordStream).toHaveBeenCalledTimes(6);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(repository.exportReady).toHaveBeenCalledWith(propertyId, "EUR", exportSnapshot);
    expect(expenses.exportCsv).toHaveBeenCalledWith(propertyId, "EUR", expenseSnapshot);
  });

  it("queues an oversized CSV without auditing or sending partial bytes", async () => {
    const repository = ports();
    repository.exportReady.mockResolvedValueOnce({
      formatVersion: "pms-financials-folios.v1",
      propertyId,
      currency: "EUR",
      contentType: "text/csv; charset=utf-8",
      filename: `pms-financials-folios-${propertyId}.csv`,
      rowCount: 1,
      body: "x".repeat(256 * 1024 + 1),
    });
    const jobs = streamJobs();
    const instance = await app(repository, context(), undefined, jobs);
    const response = await instance.inject({
      method: "POST",
      url: `${exportRoot}/auto`,
      payload: exportBody,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      propertyId,
      item: { resourceId: exportId, state: "pending" },
    });
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(jobs.recordStream).not.toHaveBeenCalled();
    expect(response.headers["content-disposition"]).toBeUndefined();
  });

  it("queues a large captured snapshot before rendering a CSV", async () => {
    const jobs = streamJobs();
    const revenue = revenueExports();
    revenue.revenue.mockResolvedValueOnce({
      ...revenueResponse,
      channels: Array.from({ length: 900 }, (_, index) => ({
        channel: `channel-${index}-${"x".repeat(150)}`,
        gross: zero(),
        commission: zero(),
        net: zero(),
        share: "0.0000",
      })),
    });
    jobs.enqueue.mockImplementation(async (command) => ({
      status: "created",
      exportId,
      envelope: command.envelope,
    }));
    const instance = await app(
      ports(),
      context(),
      undefined,
      jobs,
      undefined,
      undefined,
      undefined,
      revenue,
    );
    const response = await instance.inject({
      method: "POST",
      url: `${exportRoot}/auto`,
      payload: revenueBody,
    });
    expect(response.statusCode).toBe(202);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(
      Buffer.byteLength(JSON.stringify(jobs.enqueue.mock.calls[0]![0].snapshot), "utf8"),
    ).toBeGreaterThan(128 * 1024);
    expect(jobs.recordStream).not.toHaveBeenCalled();
    expect(response.headers["content-disposition"]).toBeUndefined();
  });

  it("rejects unauthorized, malformed, and unaudited direct exports before CSV bytes", async () => {
    const repository = ports();
    const jobs = streamJobs();
    const denied = await app(repository, context({ permissions: [] }), undefined, jobs);
    expect(
      await denied.inject({ method: "POST", url: `${exportRoot}/auto`, payload: exportBody }),
    ).toMatchObject({ statusCode: 403 });
    expect(repository.captureReadyExport).not.toHaveBeenCalled();
    const instance = await app(repository, context(), undefined, jobs);
    expect(
      await instance.inject({
        method: "POST",
        url: `${exportRoot}/auto`,
        headers: { "idempotency-key": "different" },
        payload: exportBody,
      }),
    ).toMatchObject({ statusCode: 400 });
    jobs.recordStream.mockRejectedValueOnce(new Error("private audit failure"));
    const failed = await instance.inject({
      method: "POST",
      url: `${exportRoot}/auto`,
      payload: exportBody,
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.headers["content-disposition"]).toBeUndefined();
    expect(failed.body).not.toContain("folio_id");
    expect(failed.body).not.toContain("private audit failure");
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});

describe("Financials folio write routes", () => {
  it("creates, corrects, readies, and archives with manage-only receipts and audit", async () => {
    const write = commands();
    const instance = await app(ports(), context({ permissions: ["pms.finance.manage"] }), write);
    const created = await instance.inject({
      method: "POST",
      url: root,
      headers: { "idempotency-key": "folio-create" },
      payload: writeBody(),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({
      contractVersion: "pms-financials.v1",
      propertyId,
      resourceId: folioId,
      revision: 1,
      outcome: "created",
    });
    expect(write.create).toHaveBeenCalledWith({
      ...writeBody(),
      propertyId,
      audit: commandAudit("finance.folio.create"),
    });

    const corrected = await instance.inject({
      method: "PATCH",
      url: `${root}/${folioId}`,
      payload: { ...writeBody(), commandId: correctCommandId, expectedRevision: 1 },
    });
    expect(corrected).toMatchObject({ statusCode: 200 });
    expect(write.correct).toHaveBeenCalledWith({
      ...writeBody(),
      commandId: correctCommandId,
      expectedRevision: 1,
      folioId,
      propertyId,
      audit: commandAudit("finance.folio.correct"),
    });

    const ready = await instance.inject({
      method: "POST",
      url: `${root}/${folioId}/ready`,
      payload: revisionBody(readyCommandId, "folio-ready", 2),
    });
    expect(ready.json()).toMatchObject({ revision: 3, outcome: "updated" });
    expect(write.ready).toHaveBeenCalledWith({
      ...revisionBody(readyCommandId, "folio-ready", 2),
      folioId,
      propertyId,
      audit: commandAudit("finance.folio.ready"),
    });

    const archived = await instance.inject({
      method: "DELETE",
      url: `${root}/${folioId}`,
      payload: revisionBody(archiveCommandId, "folio-archive", 3),
    });
    expect(archived.json()).toMatchObject({ revision: 4, outcome: "replayed" });
    expect(write.archive).toHaveBeenCalledWith({
      ...revisionBody(archiveCommandId, "folio-archive", 3),
      folioId,
      propertyId,
      audit: commandAudit("finance.folio.archive"),
    });
  });

  it("authorizes manage before parsing and does not treat read as manage", async () => {
    const write = commands();
    const readOnly = await app(ports(), context(), write);
    const denied = await readOnly.inject({ method: "POST", url: root, payload: { private: true } });
    expect(denied.statusCode).toBe(403);
    expect(write.create).not.toHaveBeenCalled();

    const noEntitlement = await app(
      ports(),
      context({ permissions: ["pms.finance.manage"], entitlements: [] }),
      write,
    );
    expect(
      await noEntitlement.inject({ method: "DELETE", url: `${root}/private`, payload: {} }),
    ).toMatchObject({ statusCode: 403 });
    expect(write.archive).not.toHaveBeenCalled();
  });

  it("rejects malformed idempotency and maps only typed command outcomes", async () => {
    const write = commands();
    const instance = await app(ports(), context({ permissions: ["pms.finance.manage"] }), write);
    expect(
      await instance.inject({
        method: "POST",
        url: root,
        headers: { "idempotency-key": "different" },
        payload: writeBody(),
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(write.create).not.toHaveBeenCalled();

    write.create.mockResolvedValueOnce({ status: "invalid_evidence" });
    expect(
      await instance.inject({ method: "POST", url: root, payload: writeBody() }),
    ).toMatchObject({ statusCode: 422 });
    write.correct.mockResolvedValueOnce({ status: "not_found" });
    expect(
      await instance.inject({
        method: "PATCH",
        url: `${root}/${folioId}`,
        payload: { ...writeBody(), commandId: correctCommandId, expectedRevision: 1 },
      }),
    ).toMatchObject({ statusCode: 404 });
    write.ready.mockResolvedValueOnce({ status: "conflict", reason: "revision_conflict" });
    expect(
      await instance.inject({
        method: "POST",
        url: `${root}/${folioId}/ready`,
        payload: revisionBody(readyCommandId, "folio-ready", 2),
      }),
    ).toMatchObject({ statusCode: 409 });
    write.archive.mockResolvedValueOnce({ status: "conflict", reason: "private" } as never);
    const invalid = await instance.inject({
      method: "DELETE",
      url: `${root}/${folioId}`,
      payload: revisionBody(archiveCommandId, "folio-archive", 3),
    });
    expect(invalid).toMatchObject({ statusCode: 500 });
    expect(JSON.stringify(invalid.json())).not.toContain("private");

    write.archive.mockResolvedValueOnce({
      status: "conflict",
      reason: { private: true, toString: () => "revision_conflict" },
    } as never);
    const nonStringReason = await instance.inject({
      method: "DELETE",
      url: `${root}/${folioId}`,
      payload: revisionBody(archiveCommandId, "folio-archive", 3),
    });
    expect(nonStringReason).toMatchObject({ statusCode: 500 });
    expect(JSON.stringify(nonStringReason.json())).not.toContain("private");

    write.archive.mockResolvedValueOnce({
      status: "updated",
      folioId,
      revision: 2_147_483_648,
    });
    const oversizedRevision = await instance.inject({
      method: "DELETE",
      url: `${root}/${folioId}`,
      payload: revisionBody(archiveCommandId, "folio-archive", 3),
    });
    expect(oversizedRevision).toMatchObject({ statusCode: 500 });
    expect(JSON.stringify(oversizedRevision.json())).not.toContain("2147483648");
  });
});

function writeBody() {
  return {
    commandId: folioId,
    idempotencyKey: "folio-create",
    bookingId,
    recipient: { name: "Ada Lovelace", email: "ada@example.com" },
    serviceFrom: "2026-08-20",
    serviceTo: "2026-08-21",
    lines: [
      {
        position: 1,
        kind: "room",
        description: "Stay",
        quantity: "1.0000",
        unitAmount: money,
        serviceOn: "2026-08-20",
        source: { type: "booking.nightly_revenue", id: lineId, revision: 1 },
      },
    ],
    paymentRefs: [{ paymentId, amount: money }],
  };
}

function revisionBody(commandId: string, idempotencyKey: string, expectedRevision: number) {
  return { commandId, idempotencyKey, expectedRevision };
}

function commandAudit(reason: string) {
  return {
    actor: {
      kind: "user",
      userId: "11320000-0000-4000-8000-000000000010",
      organizationId: "11320000-0000-4000-8000-000000000011",
    },
    requestId: "request-1",
    correlationId: undefined,
    reason,
    requestedAt: now,
  };
}

type Overrides = {
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
  kind?: "hotel_group" | "platform";
};
// prettier-ignore
const resource = { product: "pms" as const, resourceType: "pms_property" as const, resourceId: propertyId };
// prettier-ignore
const entitlement = (key: string, status: ProductEntitlement["status"] = "active"): ProductEntitlement => ({ product: "pms", key, status, resource });
// prettier-ignore
const hotelContext = requestContextFixtureCases.find(({ scope }) => scope === "hotel")!.context;
function context(overrides: Overrides = {}): RequestContext {
  return {
    ...hotelContext,
    actor: { ...hotelContext.actor, internalUserId: "11320000-0000-4000-8000-000000000010" },
    selectedOrganization: {
      ...hotelContext.selectedOrganization,
      organizationId: "11320000-0000-4000-8000-000000000011",
      kind: overrides.kind ?? "hotel_group",
    },
    membership: {
      ...hotelContext.membership,
      propertyAccess: {
        mode: "assigned",
        roleKey: "hotel_owner",
        accessOrigin: "agency",
        assignedPropertyIds: [propertyId],
      },
      permissions: overrides.permissions ?? ["pms.finance.read"],
    },
    entitlements: overrides.entitlements ?? [
      entitlement("property-management"),
      entitlement("module:financials"),
    ],
    linkedResources: overrides.links ?? [
      { ...resource, relationship: "owner", status: "active" },
      {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: propertyId,
        relationship: "owner",
        status: "active",
      },
    ],
    locale: "en",
    currency: "EUR",
    audit: { requestId: "request-1", receivedAt: now, source: "api" },
  };
}
