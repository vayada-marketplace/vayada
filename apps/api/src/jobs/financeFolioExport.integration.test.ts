import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import {
  FINANCE_EXPENSE_CSV_CONTENT_TYPE,
  FINANCE_EXPENSE_CSV_VERSION,
  FINANCE_DASHBOARD_WINDOW_DAYS,
  FINANCE_FOLIO_CSV_CONTENT_TYPE,
  FINANCE_FOLIO_CSV_VERSION,
  FINANCE_PROFIT_LOSS_CSV_VERSION,
  buildFinanceDashboardCsvArtifact,
  buildFinanceProfitLossCsvArtifact,
  buildFinanceRevenueCsvArtifact,
  captureFinanceDashboardExport,
  captureFinanceProfitLossExport,
  captureFinanceRevenueExport,
  financeDashboardPeriods,
  financeReportingMoneyMetric,
  type FinanceDashboardResponse,
  type FinanceFolioCsvArtifact,
  type FinanceProfitLossResponse,
  type FinanceRevenueResponse,
} from "@vayada/domain-finance";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FINANCE_EXPENSE_EXPORT_JOB,
  FINANCE_FOLIO_EXPORT_JOB,
  FINANCE_FOLIO_EXPORT_QUEUE,
  FINANCE_PROFIT_LOSS_EXPORT_JOB,
  FINANCE_DASHBOARD_EXPORT_JOB,
  FINANCE_REVENUE_EXPORT_JOB,
  createPgFinanceFolioExportJobRepository,
  parseFinanceExportJobPayload,
  type FinanceExportCommand,
} from "../domains/financeFolioExportRepository.js";
import type { FinanceExpenseExportArtifact } from "../domains/financeExpenseReadModel.js";
import {
  createS3FinanceFolioExportArtifactWriter,
  type FinanceFolioExportArtifactWriter,
} from "../platform/financeFolioExportArtifacts.js";
import { exportDeadlineClient } from "./financeExportDeadline.js";
import { runFinanceFolioExportJobs } from "./financeFolioExport.js";
import {
  assertFinanceExportWorkerBoundary,
  financeExportWorkerPrivileges,
  FINANCE_EXPORT_WORKER_ROLE,
} from "./financeExportWorkerBoundary.js";
// prettier-ignore
import { createPgPlatformMediaCleanupStore, runPlatformMediaCleanupJobs } from "./platformMediaCleanup.js";

const URL = process.env["TEST_DATABASE_URL"];
const WORKER_URL = URL ? new globalThis.URL(URL) : undefined;
if (WORKER_URL) {
  WORKER_URL.username = FINANCE_EXPORT_WORKER_ROLE;
  WORKER_URL.password = "finance-export-test";
}
const NOW = new Date("2026-09-15T01:00:00.000Z"),
  ACCEPTED = "2026-09-15T00:00:00.000Z",
  EXPIRES = "2026-09-16T00:00:00.000Z",
  SNAPSHOT_AT = "2026-09-14T23:59:59.999Z";
// prettier-ignore
const PROPERTY="11340000-0000-4000-8000-000000000020",JOB="11340000-0000-4000-8000-000000000021",OTHER_JOB="11340000-0000-4000-8000-000000000028",ORG="11340000-0000-4000-8000-000000000022",COMMAND="11340000-0000-4000-8000-000000000023",CAUSE="11340000-0000-4000-8000-000000000024",ACTOR="11340000-0000-4000-8000-000000000025",EXPENSE="11340000-0000-4000-8000-000000000026",CATEGORY="11340000-0000-4000-8000-000000000027";
if (URL && !/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(URL).pathname))
  throw new Error("Unsafe test database");

function profitLossSnapshot() {
  const zero = () => ({ amount: "0.0000", currency: "EUR" });
  const categories = () =>
    Object.fromEntries(
      ["ota_commission", "staff", "utilities", "maintenance_supplies", "marketing_platform"].map(
        (key) => [key, zero()],
      ),
    ) as FinanceProfitLossResponse["months"][number]["expenseCategories"];
  const response: FinanceProfitLossResponse = {
    contractVersion: "pms-financials.v1",
    propertyId: PROPERTY,
    currency: "EUR",
    timeZone: "Europe/Berlin",
    generatedAt: SNAPSHOT_AT,
    sourceFreshness: {},
    incompleteEvidence: [],
    summary: {
      revenueYtd: financeReportingMoneyMetric("0", "0", "EUR"),
      expensesYtd: financeReportingMoneyMetric("0", "0", "EUR"),
      netProfitYtd: financeReportingMoneyMetric("0", "0", "EUR"),
    },
    months: Array.from({ length: 9 }, (_, index) => ({
      month: `2026-${String(index + 1).padStart(2, "0")}`,
      roomRevenue: zero(),
      upsellRevenue: zero(),
      revenue: zero(),
      expenses: zero(),
      netProfit: zero(),
      expenseCategories: categories(),
    })),
  };
  return captureFinanceProfitLossExport({
    propertyId: PROPERTY,
    response,
    query: { year: 2026 },
    asOf: "2026-09-15",
    categoryRows: [],
  });
}

function revenueSnapshot() {
  const response: FinanceRevenueResponse = {
    contractVersion: "pms-financials.v1",
    propertyId: PROPERTY,
    currency: "EUR",
    timeZone: "Europe/Berlin",
    generatedAt: SNAPSHOT_AT,
    sourceFreshness: {},
    incompleteEvidence: [],
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
  return captureFinanceRevenueExport({
    propertyId: PROPERTY,
    response,
    query: { from: "2026-09-01", to: "2026-09-15" },
  });
}

function dashboardSnapshot() {
  const zero = () => ({ amount: "0.0000", currency: "EUR" });
  const dailyFrom = Date.parse(`${financeDashboardPeriods("2026-09-15").daily.from}T00:00:00Z`);
  const response: FinanceDashboardResponse = {
    contractVersion: "pms-financials.v1",
    propertyId: PROPERTY,
    currency: "EUR",
    timeZone: "Europe/Berlin",
    generatedAt: SNAPSHOT_AT,
    sourceFreshness: {},
    incompleteEvidence: [],
    cards: {
      revenueToday: financeReportingMoneyMetric("0", "0", "EUR"),
      revenueMtd: financeReportingMoneyMetric("0", "0", "EUR"),
      expensesMtd: financeReportingMoneyMetric("0", "0", "EUR"),
      profitMtd: financeReportingMoneyMetric("0", "0", "EUR"),
    },
    daily: Array.from({ length: FINANCE_DASHBOARD_WINDOW_DAYS }, (_, index) => ({
      date: new Date(dailyFrom + index * 86_400_000).toISOString().slice(0, 10),
      revenue: zero(),
      expenses: zero(),
    })),
    upcoming: [],
  };
  return captureFinanceDashboardExport({ propertyId: PROPERTY, response, query: {} });
}

it("validates the durable P&L payload against accepted scope and reconciled evidence", () => {
  const snapshot = profitLossSnapshot();
  const payload = { commandId: COMMAND, organizationId: ORG, snapshot, expiresAt: EXPIRES };
  const expected = {
    organizationId: ORG,
    propertyId: PROPERTY,
    currency: "EUR",
    payloadFingerprint: hash(payload),
    acceptedAt: ACCEPTED,
    snapshotAt: SNAPSHOT_AT,
    expiresAt: EXPIRES,
    now: NOW,
  };
  expect(parseFinanceExportJobPayload(payload, expected)).toEqual(payload);
  const reordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(reordered)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, part]) => [key, reordered(part)]),
          )
        : value;
  expect(JSON.stringify(parseFinanceExportJobPayload(reordered(payload), expected))).toBe(
    JSON.stringify(payload),
  );
  const corrupt = structuredClone(payload);
  corrupt.snapshot.manifest[0].response.months[0]!.netProfit.amount = "1.0000";
  expect(() => parseFinanceExportJobPayload(corrupt, expected)).toThrow(TypeError);
  expect(() => parseFinanceExportJobPayload(payload, { ...expected, propertyId: ORG })).toThrow(
    TypeError,
  );
});

it("rejects P&L response metadata that does not describe the pinned CSV cutoff", async () => {
  const snapshot = profitLossSnapshot();
  const {
    contractVersion,
    propertyId,
    currency,
    timeZone,
    generatedAt,
    sourceFreshness,
    incompleteEvidence,
  } = snapshot.manifest[0].response;
  const envelope = {
    contractVersion,
    propertyId,
    currency,
    timeZone,
    generatedAt,
    sourceFreshness,
    incompleteEvidence,
  };
  const connect = vi.fn(async () => {
    throw new Error("connected");
  });
  const repository = createPgFinanceFolioExportJobRepository({
    pool: { connect } as unknown as pg.Pool,
    searchDigest: async () => "a".repeat(64),
  });
  const command = {
    commandId: COMMAND,
    idempotencyKey: "profit-loss-test",
    organizationId: ORG,
    propertyId: PROPERTY,
    currency: "EUR",
    filters: { year: 2026 },
    snapshot,
    envelope,
    audit: {
      actorUserId: ACTOR,
      requestId: "request-vay-1134",
      correlationId: "correlation-vay-1134",
      causationId: CAUSE,
      requestedAt: ACCEPTED,
    },
  };
  await expect(repository.enqueue(command)).rejects.toThrow("connected");
  for (const changed of [
    { ...envelope, generatedAt: "2026-09-15T00:00:00.000Z" },
    { ...envelope, timeZone: "UTC" },
  ])
    await expect(repository.enqueue({ ...command, envelope: changed })).rejects.toThrow(TypeError);
  expect(connect).toHaveBeenCalledTimes(1);
});

// prettier-ignore
it("writes immutable private CSV bytes with integrity and expiry metadata", async () => {
  const send = vi.fn(async (_command: unknown, _options?: unknown) => ({})), destroy = vi.fn();
  const writer = createS3FinanceFolioExportArtifactWriter({ bucketName: "test-private", s3Client: { send, destroy } as unknown as S3Client });
  const stored = await writer.write({ exportId: JOB, body: "guest,amount\r\nAda,12\r\n", contentType: FINANCE_FOLIO_CSV_CONTENT_TYPE, formatVersion: FINANCE_FOLIO_CSV_VERSION, expiresAt: EXPIRES });
  const command = send.mock.calls[0]![0] as PutObjectCommand;
  expect(command.input).toMatchObject({ Bucket: "test-private", Key: `private/finance/financials-exports/${JOB}/${FINANCE_FOLIO_CSV_VERSION}.csv`, ContentType: FINANCE_FOLIO_CSV_CONTENT_TYPE, CacheControl: "private, no-store", ChecksumSHA256: createHash("sha256").update("guest,amount\r\nAda,12\r\n").digest("base64"), Metadata: { "expires-at": EXPIRES } });
  expect(command.input.Expires?.toISOString()).toBe(EXPIRES);
  expect(stored).toMatchObject({ bucketName: "test-private", sizeBytes: 22, checksumSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  const signal = AbortSignal.timeout(1_000);
  await writer.write({ exportId: JOB, body: "x", contentType: FINANCE_FOLIO_CSV_CONTENT_TYPE, formatVersion: FINANCE_FOLIO_CSV_VERSION, expiresAt: EXPIRES, signal });
  expect(send.mock.calls[1]![1]).toMatchObject({ abortSignal: signal });
  writer.close?.(); expect(destroy).not.toHaveBeenCalled();
});

// prettier-ignore
describe.skipIf(!URL)("PostgreSQL Finance folio export worker", () => {
  const admin = new pg.Client({ connectionString: URL ?? "postgresql://disabled" }), adminPool = new pg.Pool({ connectionString: URL ?? "postgresql://disabled", max: 2 }), pool = new pg.Pool({ connectionString: WORKER_URL?.toString() ?? "postgresql://disabled", max: 2 });
  const artifact: FinanceFolioCsvArtifact = { formatVersion: FINANCE_FOLIO_CSV_VERSION, contentType: FINANCE_FOLIO_CSV_CONTENT_TYPE, propertyId: PROPERTY, currency: "EUR", filename: `pms-financials-folios-${PROPERTY}.csv`, rowCount: 0, body: '"property_id"\r\n', auditEvidence: [] };
  const expenseSelection={expenseId:EXPENSE,revision:1,categoryId:CATEGORY,categoryRevision:1,categoryName:"Operations",paymentStatus:"unpaid" as const,paidOn:null};
  const expenseArtifact: FinanceExpenseExportArtifact = { formatVersion: FINANCE_EXPENSE_CSV_VERSION, contentType: FINANCE_EXPENSE_CSV_CONTENT_TYPE, propertyId: PROPERTY, currency: "EUR", filename: `pms-financials-expenses-${PROPERTY}.csv`, rowCount: 1, body: '"property_id"\r\n"expense"\r\n', auditEvidence: [expenseSelection] };
  const read = { exportReady: vi.fn(async () => artifact), exportCsv: vi.fn(async () => expenseArtifact) };
  beforeAll(async () => { await admin.connect(); await provisionWorker(); await cleanup(); await admin.query("INSERT INTO identity.users(id,email,name,status) VALUES($1,'folio-worker@example.test','Folio worker','active')",[ACTOR]);await admin.query("INSERT INTO identity.organizations(id,kind,name,slug,status) VALUES($1,'hotel_group','Folio worker org','folio-worker-org','active')",[ORG]);await admin.query("INSERT INTO hotel_catalog.properties(id,public_id,display_name) VALUES($1,'folio-export-worker','Folio export worker')", [PROPERTY]);await admin.query("INSERT INTO platform.finance_export_worker_properties(property_id) VALUES($1)",[PROPERTY]);await admin.query("INSERT INTO identity.organization_memberships(organization_id,user_id,status,role_key,access_origin) VALUES($1,$2,'active','owner','agency')",[ORG,ACTOR]);await admin.query("INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship,status) VALUES($1,'pms','pms_property',$2,'owner','active')",[ORG,PROPERTY]);await admin.query("INSERT INTO pms.property_pricing_settings(property_id,currency) VALUES($1,'EUR')",[PROPERTY]);await assertFinanceExportWorkerBoundary(admin,{propertyId:PROPERTY}); });
  beforeEach(async () => { await cleanupJobs(); read.exportReady.mockClear(); read.exportCsv.mockClear(); });
  afterAll(async () => { await cleanup(); await Promise.all([pool.end(),adminPool.end()]); await admin.end(); });

  it("fails closed before claiming when the exact export scope is missing", async () => {
    await expect(
      runFinanceFolioExportJobs(pool, read, fakeWriter(), {
        exportId: undefined as unknown as string,
        clock: () => NOW,
      }),
    ).rejects.toThrow("finance_export_worker_export_scope_invalid");
  });

  it("claims a fresh Dashboard export once and cannot retry or reclaim it", async () => {
    const acceptedAt = new Date(Date.now() - 2_000);
    const dispatchedAt = new Date(acceptedAt.getTime() - 1_000);
    await insertOneShotDashboardJob(acceptedAt);
    const writer = fakeWriter();
    const scope = { exportId: JOB, oneShot: { propertyId: PROPERTY, dispatchedAt } };
    await expect(runFinanceFolioExportJobs(pool, read, writer, scope)).resolves.toEqual({ succeeded: 1, retryScheduled: 0, deadLettered: 0 });
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.write.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
    await expect(runFinanceFolioExportJobs(pool, read, writer, scope)).resolves.toEqual({ succeeded: 0, retryScheduled: 0, deadLettered: 0 });
    expect((await admin.query("SELECT status,attempts_count::int attempts FROM platform.jobs WHERE id=$1", [JOB])).rows[0]).toEqual({ status: "succeeded", attempts: 1 });

    await cleanupJobs(); await insertOneShotDashboardJob(acceptedAt);
    await admin.query("UPDATE platform.jobs SET attempts_count=1 WHERE id=$1", [JOB]);
    await expect(runFinanceFolioExportJobs(pool, read, fakeWriter(), scope)).resolves.toEqual({ succeeded: 0, retryScheduled: 0, deadLettered: 0 });
    await admin.query("UPDATE platform.jobs SET status='running',locked_at=$2,locked_by='one-shot-test' WHERE id=$1", [JOB, new Date(Date.now() - 360_000)]);
    await expect(runFinanceFolioExportJobs(pool, read, fakeWriter(), scope)).resolves.toEqual({ succeeded: 0, retryScheduled: 0, deadLettered: 0 });
    await admin.query("UPDATE platform.jobs SET status='pending',attempts_count=0,locked_at=NULL,locked_by=NULL WHERE id=$1", [JOB]);
    await expect(runFinanceFolioExportJobs(pool, read, fakeWriter(), { exportId: JOB, oneShot: { propertyId: OTHER_JOB, dispatchedAt } })).resolves.toEqual({ succeeded: 0, retryScheduled: 0, deadLettered: 0 });
  });

  it("does not claim a Dashboard export after the dispatch deadline", async () => {
    const acceptedAt = new Date(Date.now() - 16 * 60_000);
    await insertOneShotDashboardJob(acceptedAt);
    await expect(runFinanceFolioExportJobs(pool, read, fakeWriter(), { exportId: JOB, oneShot: { propertyId: PROPERTY, dispatchedAt: new Date(acceptedAt.getTime() - 1_000) } })).resolves.toEqual({ succeeded: 0, retryScheduled: 0, deadLettered: 0 });
    expect((await admin.query("SELECT status,attempts_count::int attempts FROM platform.jobs WHERE id=$1", [JOB])).rows[0]).toEqual({ status: "pending", attempts: 0 });
  });

  it("dead-letters an ambiguous one-shot write without allowing another claim", async () => {
    const acceptedAt = new Date(Date.now() - 2_000);
    const scope = { exportId: JOB, oneShot: { propertyId: PROPERTY, dispatchedAt: new Date(acceptedAt.getTime() - 1_000) } };
    await insertOneShotDashboardJob(acceptedAt);
    const writer = fakeWriter(); writer.write.mockRejectedValueOnce(new Error("S3 outcome unknown"));
    await expect(runFinanceFolioExportJobs(pool, read, writer, scope)).resolves.toEqual({ succeeded: 0, retryScheduled: 0, deadLettered: 1 });
    expect((await admin.query("SELECT status,attempts_count::int attempts,job_metadata->>'lastErrorCode' code,(SELECT lifecycle_status FROM platform.media_objects WHERE id=platform.jobs.id) media FROM platform.jobs WHERE id=$1", [JOB])).rows[0]).toEqual({ status: "dead_lettered", attempts: 1, code: "artifact_write_ambiguous", media: "upload_pending" });
    await expect(runFinanceFolioExportJobs(pool, read, writer, scope)).resolves.toEqual({ succeeded: 0, retryScheduled: 0, deadLettered: 0 });
    expect(writer.write).toHaveBeenCalledTimes(1);
  });

  it("cancels a database statement within its remaining budget", async () => {
    const raw = await pool.connect(), deadline = Date.now() + 150;
    const client = exportDeadlineClient(raw, () => deadline);
    try {
      await expect(client.query("SELECT pg_sleep(2)")).rejects.toThrow(/timeout|canceling statement|Connection terminated/);
    } finally { client.release(true); }
  });

  it("releases an acquired connection if the deadline has already passed", async () => {
    const raw = await pool.connect(), release = vi.spyOn(raw, "release");
    expect(() => exportDeadlineClient(raw, () => Date.now() - 1)).toThrow("one_shot_deadline_passed");
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("closes the dedicated connection when timeout configuration responds late", async () => {
    const raw = await pool.connect(), deadline = Date.now() + 100;
    const release = vi.spyOn(raw, "release"), statements: string[] = [];
    const delayed = new Proxy(raw, { get(target, key) {
      if (key !== "query") return Reflect.get(target, key);
      return async (config: { text: string }) => {
        statements.push(config.text);
        const result = await target.query(config);
        await new Promise((resolve) => setTimeout(resolve, 150));
        return result;
      };
    } });
    const client = exportDeadlineClient(delayed, () => deadline);
    try {
      await expect(client.query("SELECT pg_sleep(2)")).rejects.toThrow("one_shot_deadline_passed");
      expect(release).toHaveBeenCalledWith(true);
      expect(statements).toEqual(["SELECT set_config('statement_timeout',$1,false)"]);
    } finally { client.release(true); }
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not finalize a write whose receipt arrives after the deadline", async () => {
    const accepted = new Date(Date.now() - 2_000), dispatch = new Date(accepted.getTime() - 1_000);
    await insertOneShotDashboardJob(accepted);
    let now = new Date(); const writer = fakeWriter(), original = writer.write.getMockImplementation()! as FinanceFolioExportArtifactWriter["write"];
    writer.write.mockImplementationOnce(async (input) => { const result = await original(input); now = new Date(dispatch.getTime() + 900_000); return result; });
    const scope = { exportId: JOB, oneShot: { propertyId: PROPERTY, dispatchedAt: dispatch }, clock: () => now };
    await expect(runFinanceFolioExportJobs(pool, read, writer, scope)).rejects.toThrow("one_shot_deadline_passed");
    expect((await admin.query("SELECT status,attempts_count::int attempts,(SELECT lifecycle_status FROM platform.media_objects WHERE id=platform.jobs.id) media FROM platform.jobs WHERE id=$1", [JOB])).rows[0]).toEqual({ status: "running", attempts: 1, media: "upload_pending" });
    await expect(runFinanceFolioExportJobs(pool, read, writer, { ...scope, clock: () => new Date() })).resolves.toEqual({ succeeded: 0, retryScheduled: 0, deadLettered: 0 });
    expect(writer.write).toHaveBeenCalledTimes(1);
  });

  it("does not finalize after waiting on a database lock beyond the deadline", async () => {
    const accepted = new Date(Date.now() - 899_300), dispatch = new Date(accepted.getTime() - 10);
    await insertOneShotDashboardJob(accepted);
    const writer = fakeWriter(), original = writer.write.getMockImplementation()! as FinanceFolioExportArtifactWriter["write"];
    writer.write.mockImplementationOnce(async (input) => {
      await admin.query("BEGIN"); await admin.query("SELECT id FROM platform.jobs WHERE id=$1 FOR UPDATE", [JOB]);
      return original(input);
    });
    try {
      await expect(runFinanceFolioExportJobs(pool, read, writer, { exportId: JOB, oneShot: { propertyId: PROPERTY, dispatchedAt: dispatch } })).rejects.toThrow(/timeout|deadline|canceling statement|Connection terminated/);
    } finally { await admin.query("ROLLBACK"); }
    expect((await admin.query("SELECT status,attempts_count::int attempts FROM platform.jobs WHERE id=$1", [JOB])).rows[0]).toEqual({ status: "running", attempts: 1 });
    expect(writer.write).toHaveBeenCalledTimes(1);
  });

  it("renders one immutable manifest, stores only sanitized metadata, and audits success", async () => {
    await insertJob(); const writer = fakeWriter(),afterRender=new Date(NOW.getTime()+360_000),times=[NOW,afterRender,afterRender,afterRender];
    writer.write.mockImplementationOnce(async({exportId,body})=>{expect((await admin.query("SELECT lifecycle_status FROM platform.media_objects WHERE id=$1",[exportId])).rows[0]?.lifecycle_status).toBe("upload_pending");await expect(runFinanceFolioExportJobs(pool,read,fakeWriter(),{exportId:JOB,workerId:"worker-two",clock:()=>afterRender})).resolves.toEqual({succeeded:0,retryScheduled:0,deadLettered:0});return receipt(exportId,body)});
    await expect(runFinanceFolioExportJobs(pool, read, writer, { exportId: JOB, workerId: "worker-one", clock: () => times.shift()! })).resolves.toEqual({ succeeded: 1, retryScheduled: 0, deadLettered: 0 });
    expect(read.exportReady).toHaveBeenCalledWith(PROPERTY, "EUR", expect.objectContaining({ snapshotAt: SNAPSHOT_AT, manifest: [] }));
    expect(writer.write).toHaveBeenCalledWith({ exportId: JOB, body: artifact.body, contentType: FINANCE_FOLIO_CSV_CONTENT_TYPE, formatVersion: FINANCE_FOLIO_CSV_VERSION, expiresAt: EXPIRES });
    const row = (await admin.query(`SELECT job.status,job.attempts_count::int attempts,job.job_metadata->'artifact' artifact,(SELECT status FROM platform.job_attempts WHERE job_id=job.id) attempt,(SELECT redacted_payload FROM platform.product_audit_events WHERE job_id=job.id AND action='finance.folio_export.succeeded') audit,(SELECT audit_metadata FROM platform.product_audit_events WHERE job_id=job.id AND action='finance.folio_export.succeeded') "auditMetadata",(SELECT jsonb_build_object('purpose',purpose,'owner',owner_organization_id,'property',property_id,'status',lifecycle_status,'retainedUntil',to_char(retained_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'key',storage_key) FROM platform.media_objects WHERE id=job.id) media,to_jsonb(job)::text serialized FROM platform.jobs job WHERE id=$1`, [JOB])).rows[0];
    expect(row).toMatchObject({ status: "succeeded", attempts: 1, attempt: "succeeded", artifact: { mediaId: JOB, filename: artifact.filename, contentType: artifact.contentType, formatVersion: artifact.formatVersion, rowCount: 0, expiresAt: EXPIRES }, audit: { outcome: "succeeded", attemptNumber: 1, rowCount: 0, manifestCount: 0 }, auditMetadata:{organizationId:ORG,initiatingActorUserId:ACTOR}, media:{purpose:"finance.financials_export",owner:ORG,property:PROPERTY,status:"active",retainedUntil:EXPIRES,key:`private/finance/financials-exports/${JOB}/${FINANCE_FOLIO_CSV_VERSION}.csv`} });
    expect(row.artifact).not.toHaveProperty("storageKey"); expect(row.artifact).not.toHaveProperty("bucketName");
    expect(row.serialized).not.toContain(artifact.body);
  });

  it("claims only the configured export when another eligible job exists", async () => {
    await insertJob({ id: OTHER_JOB });
    await insertJob();
    const writer = fakeWriter();
    await expect(
      runFinanceFolioExportJobs(pool, read, writer, { exportId: JOB, clock: () => NOW }),
    ).resolves.toEqual({ succeeded: 1, retryScheduled: 0, deadLettered: 0 });
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({ exportId: JOB }));
    expect(
      (
        await admin.query(
          "SELECT id::text,status FROM platform.jobs WHERE id IN ($1::uuid,$2::uuid) ORDER BY id",
          [JOB, OTHER_JOB],
        )
      ).rows,
    ).toEqual([
      { id: JOB, status: "succeeded" },
      { id: OTHER_JOB, status: "pending" },
    ]);
  });

  it("renders expense manifests through the same durable worker without folio access", async () => {
    await insertExpenseJob(); const writer=fakeWriter();
    await expect(runFinanceFolioExportJobs(pool,read,writer,{exportId:JOB,clock:()=>NOW})).resolves.toEqual({succeeded:1,retryScheduled:0,deadLettered:0});
    expect(read.exportCsv).toHaveBeenCalledWith(PROPERTY,"EUR",expect.objectContaining({formatVersion:FINANCE_EXPENSE_CSV_VERSION,manifest:[expenseSelection]}));expect(read.exportReady).not.toHaveBeenCalled();
    expect(writer.write).toHaveBeenCalledWith({exportId:JOB,body:expenseArtifact.body,contentType:FINANCE_EXPENSE_CSV_CONTENT_TYPE,formatVersion:FINANCE_EXPENSE_CSV_VERSION,expiresAt:EXPIRES});
    expect((await admin.query("SELECT job_metadata->'artifact' artifact,(SELECT storage_key FROM platform.media_objects WHERE id=platform.jobs.id) key,(SELECT action FROM platform.product_audit_events WHERE job_id=platform.jobs.id) action,(SELECT audit_metadata->>'jobType' FROM platform.product_audit_events WHERE job_id=platform.jobs.id) \"jobType\" FROM platform.jobs WHERE id=$1",[JOB])).rows[0]).toMatchObject({artifact:{formatVersion:FINANCE_EXPENSE_CSV_VERSION,filename:expenseArtifact.filename},key:`private/finance/financials-exports/${JOB}/${FINANCE_EXPENSE_CSV_VERSION}.csv`,action:"finance.expense_export.succeeded",jobType:FINANCE_EXPENSE_EXPORT_JOB});
    await expect(createPgFinanceFolioExportJobRepository({pool:adminPool,searchDigest:async()=>"a".repeat(64)}).find({exportId:JOB,organizationId:ORG,propertyId:PROPERTY,now:NOW})).resolves.toMatchObject({state:"ready",artifact:{filename:expenseArtifact.filename,storageKey:`private/finance/financials-exports/${JOB}/${FINANCE_EXPENSE_CSV_VERSION}.csv`}});
  });

  it("regenerates P&L CSV only from the pinned reconciled snapshot", async () => {
    const snapshot = profitLossSnapshot();
    await insertReportJob(snapshot, FINANCE_PROFIT_LOSS_EXPORT_JOB);
    const writer = fakeWriter();
    await expect(runFinanceFolioExportJobs(pool, read, writer, { exportId: JOB, clock: () => NOW })).resolves.toEqual({
      succeeded: 1,
      retryScheduled: 0,
      deadLettered: 0,
    });
    const artifact = buildFinanceProfitLossCsvArtifact({
      propertyId: PROPERTY,
      response: snapshot.manifest[0].response,
      query: snapshot.filters,
      asOf: snapshot.asOf,
      categoryRows: snapshot.manifest[0].categoryRows,
    });
    expect(writer.write).toHaveBeenCalledWith({
      exportId: JOB,
      body: artifact.body,
      contentType: artifact.contentType,
      formatVersion: FINANCE_PROFIT_LOSS_CSV_VERSION,
      expiresAt: EXPIRES,
    });
    expect(read.exportReady).not.toHaveBeenCalled();
    expect(read.exportCsv).not.toHaveBeenCalled();
    await expect(
      createPgFinanceFolioExportJobRepository({ pool: adminPool, searchDigest: async () => "a".repeat(64) }).find({
        exportId: JOB,
        organizationId: ORG,
        propertyId: PROPERTY,
        now: NOW,
      }),
    ).resolves.toMatchObject({ state: "ready", artifact: { filename: artifact.filename } });
    expect((await admin.query("SELECT action FROM platform.product_audit_events WHERE job_id=$1", [JOB])).rows[0].action).toBe("finance.profit_loss_export.succeeded");
  });

  const revenue = revenueSnapshot(), dashboard = dashboardSnapshot();
  it.each([
    {
      tab: "revenue", jobType: FINANCE_REVENUE_EXPORT_JOB, snapshot: revenue,
      artifact: buildFinanceRevenueCsvArtifact({ propertyId: PROPERTY, response: revenue.manifest[0].response, query: revenue.filters }),
    },
    {
      tab: "dashboard", jobType: FINANCE_DASHBOARD_EXPORT_JOB, snapshot: dashboard,
      artifact: buildFinanceDashboardCsvArtifact({ propertyId: PROPERTY, response: dashboard.manifest[0].response, query: dashboard.filters }),
    },
  ])("regenerates $tab CSV from the pinned snapshot and exposes the scoped artifact", async ({ tab, jobType, snapshot, artifact }) => {
    await insertReportJob(snapshot, jobType);
    const writer = fakeWriter();
    await expect(runFinanceFolioExportJobs(pool, read, writer, { exportId: JOB, clock: () => NOW })).resolves.toEqual({ succeeded: 1, retryScheduled: 0, deadLettered: 0 });
    expect(writer.write).toHaveBeenCalledWith({ exportId: JOB, body: artifact.body, contentType: artifact.contentType, formatVersion: artifact.formatVersion, expiresAt: EXPIRES });
    expect(read.exportReady).not.toHaveBeenCalled();
    expect(read.exportCsv).not.toHaveBeenCalled();
    await expect(createPgFinanceFolioExportJobRepository({ pool: adminPool, searchDigest: async () => "a".repeat(64) }).find({ exportId: JOB, organizationId: ORG, propertyId: PROPERTY, now: NOW })).resolves.toMatchObject({ state: "ready", artifact: { filename: artifact.filename, storageKey: `private/finance/financials-exports/${JOB}/${artifact.formatVersion}.csv` } });
    expect((await admin.query("SELECT action FROM platform.product_audit_events WHERE job_id=$1", [JOB])).rows[0].action).toBe(`finance.${tab}_export.succeeded`);
  });

  it.each([
    { tab: "revenue", jobType: FINANCE_REVENUE_EXPORT_JOB, snapshot: revenue },
    { tab: "dashboard", jobType: FINANCE_DASHBOARD_EXPORT_JOB, snapshot: dashboard },
  ])("enqueues $tab with idempotency and a redacted requested audit", async ({ tab, jobType, snapshot }) => {
    const response = snapshot.manifest[0].response;
    const { contractVersion, propertyId, currency, timeZone, generatedAt, sourceFreshness, incompleteEvidence } = response;
    const repository = createPgFinanceFolioExportJobRepository({ pool: adminPool, searchDigest: async () => "a".repeat(64) });
    const command = {
      commandId: COMMAND, idempotencyKey: `VAY-1134-${tab}`, organizationId: ORG,
      propertyId: PROPERTY, currency: "EUR", filters: snapshot.filters, snapshot,
      envelope: { contractVersion, propertyId, currency, timeZone, generatedAt, sourceFreshness, incompleteEvidence },
      audit: { actorUserId: ACTOR, requestId: `request-${tab}`, correlationId: `correlation-${tab}`, causationId: CAUSE, requestedAt: NOW.toISOString() },
    } as FinanceExportCommand;
    const created = await repository.enqueue(command);
    if (created.status === "conflict") throw new Error("Expected report export");
    await expect(repository.enqueue(command)).resolves.toMatchObject({ status: "replayed", exportId: created.exportId });
    await expect(repository.enqueue({ ...command, commandId: CAUSE })).resolves.toEqual({ status: "conflict" });
    const row = (await admin.query(`SELECT job.job_type,job.payload->'snapshot'->>'formatVersion' format_version,audit.action,audit.redacted_payload,audit.private_payload,(SELECT count(*)::int FROM platform.idempotency_keys WHERE id=job.id) idempotency_count FROM platform.jobs job JOIN platform.product_audit_events audit ON audit.job_id=job.id WHERE job.id=$1`, [created.exportId])).rows[0];
    expect(row).toMatchObject({ job_type: jobType, format_version: snapshot.formatVersion, action: `finance.${tab}_export.requested`, redacted_payload: { formatVersion: snapshot.formatVersion, filters: snapshot.filters, manifestCount: 1 }, private_payload: {}, idempotency_count: 1 });
    expect((await admin.query("SELECT count(*)::int count FROM platform.product_audit_events WHERE job_id=$1", [created.exportId])).rows[0].count).toBe(1);
  });

  it("rejects unbound expense artifacts and labels malformed expense jobs correctly", async () => {
    await insertExpenseJob();const writer=fakeWriter();read.exportCsv.mockResolvedValueOnce({...expenseArtifact,auditEvidence:[{...expenseSelection,revision:2}]});
    await expect(runFinanceFolioExportJobs(pool,read,writer,{exportId:JOB,clock:()=>NOW})).resolves.toMatchObject({deadLettered:1});expect(writer.write).not.toHaveBeenCalled();
    await cleanupJobs();await insertExpenseJob(FINANCE_FOLIO_CSV_VERSION);read.exportCsv.mockClear();
    await expect(runFinanceFolioExportJobs(pool,read,writer,{exportId:JOB,clock:()=>NOW})).resolves.toMatchObject({deadLettered:1});expect(read.exportCsv).not.toHaveBeenCalled();
    expect((await admin.query("SELECT attempt.error_message,dead.failure_summary,audit.action FROM platform.jobs job JOIN platform.job_attempts attempt ON attempt.job_id=job.id JOIN platform.dead_letter_events dead ON dead.job_id=job.id JOIN platform.product_audit_events audit ON audit.job_id=job.id WHERE job.id=$1",[JOB])).rows[0]).toEqual({error_message:"Finance expense export failed (invalid_export_evidence).",failure_summary:"Finance expense export failed (invalid_export_evidence).",action:"finance.expense_export.dead_lettered"});
  });

  it("retries storage failures at the same object key and recovers an expired lease", async () => {
    await insertJob(); const writer = fakeWriter(); writer.write.mockRejectedValueOnce(new Error("S3 unavailable"));
    await expect(runFinanceFolioExportJobs(pool, read, writer, { exportId: JOB, clock: () => NOW, random:()=>0.25 })).resolves.toMatchObject({ retryScheduled: 1 });
    expect((await admin.query(`SELECT to_char(run_after AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS run_after FROM platform.jobs WHERE id=$1`,[JOB])).rows[0].run_after).toBe("2026-09-15T01:00:22.500Z");
    expect((await admin.query("SELECT audit_metadata FROM platform.product_audit_events WHERE job_id=$1 AND action='finance.folio_export.retry_scheduled'",[JOB])).rows[0].audit_metadata).toMatchObject({organizationId:ORG,initiatingActorUserId:ACTOR});
    await expect(runFinanceFolioExportJobs(pool, read, writer, { exportId: JOB, clock: () => new Date(NOW.getTime() + 31_000) })).resolves.toMatchObject({ succeeded: 1 });
    expect(writer.write.mock.calls.map(([value]) => value.exportId)).toEqual([JOB, JOB]);
    expect((await admin.query("SELECT status,attempts_count::int attempts,(SELECT array_agg(status ORDER BY attempt_number) FROM platform.job_attempts WHERE job_id=platform.jobs.id) statuses FROM platform.jobs WHERE id=$1", [JOB])).rows[0]).toEqual({ status: "succeeded", attempts: 2, statuses: ["failed", "succeeded"] });
    await cleanupJobs(); await insertJob({ status: "running", attempts: 1, lockedAt: new Date(NOW.getTime() - 301_000).toISOString() });
    await expect(runFinanceFolioExportJobs(pool, read, fakeWriter(), { exportId: JOB, clock: () => NOW })).resolves.toMatchObject({ succeeded: 1 });
    expect((await admin.query("SELECT array_agg(status ORDER BY attempt_number) statuses FROM platform.job_attempts WHERE job_id=$1", [JOB])).rows[0].statuses).toEqual(["timed_out", "succeeded"]);
  });

  it("dead-letters expired evidence without writing an artifact", async () => {
    await insertJob(); const writer = fakeWriter();
    await expect(runFinanceFolioExportJobs(pool, read, writer, { exportId: JOB, clock: () => new Date(EXPIRES) })).resolves.toEqual({ succeeded: 0, retryScheduled: 0, deadLettered: 1 });
    expect(writer.write).not.toHaveBeenCalled(); expect(read.exportReady).not.toHaveBeenCalled();
    const row = (await admin.query("SELECT status,job_metadata->>'lastErrorCode' code,(SELECT reason_code FROM platform.dead_letter_events WHERE job_id=platform.jobs.id) dead,(SELECT failure_payload FROM platform.dead_letter_events WHERE job_id=platform.jobs.id) payload,(SELECT redacted_payload->>'failureCode' FROM platform.product_audit_events WHERE job_id=platform.jobs.id AND action='finance.folio_export.dead_lettered') audit FROM platform.jobs WHERE id=$1", [JOB])).rows[0];
    expect(row).toMatchObject({ status: "dead_lettered", code: "export_expired", dead: "export_expired", audit: "export_expired",payload:{attemptNumber:1,affectedOrganizationId:ORG,lastAttemptAt:EXPIRES,ownerPackage:"backend-events",replayEligible:false} });
    await cleanupJobs(); await insertReportJob(dashboardSnapshot(), FINANCE_DASHBOARD_EXPORT_JOB);
    const twelveHoursLate = new Date(new Date(EXPIRES).getTime() + 12 * 60 * 60_000);
    await expect(runFinanceFolioExportJobs(pool, read, writer, { exportId: JOB, clock: () => twelveHoursLate })).resolves.toEqual({ succeeded: 0, retryScheduled: 0, deadLettered: 1 });
    expect(writer.write).not.toHaveBeenCalled();
    expect((await admin.query("SELECT status,attempts_count::int attempts,job_metadata->>'lastErrorCode' code FROM platform.jobs WHERE id=$1", [JOB])).rows[0]).toEqual({ status: "dead_lettered", attempts: 1, code: "export_expired" });
    await cleanupJobs();await insertJob();const lateWriter=fakeWriter(),beforeExpiry=new Date(new Date(EXPIRES).getTime()-1),times=[beforeExpiry,beforeExpiry,new Date(EXPIRES),new Date(EXPIRES)],deleted=vi.fn(async()=>undefined),cleanupStore=createPgPlatformMediaCleanupStore({connectionString:URL!,objectDeleter:{deleteObject:deleted,deletePrefix:vi.fn(async()=>undefined)}});lateWriter.write.mockImplementationOnce(async({exportId,body})=>{await expect(runPlatformMediaCleanupJobs(cleanupStore,{now:new Date(EXPIRES),run:["privateAttachmentRetention"]})).resolves.toMatchObject({scanned:0});return receipt(exportId,body)});await expect(runFinanceFolioExportJobs(pool,read,lateWriter,{exportId:JOB,clock:()=>times.shift()!})).resolves.toMatchObject({deadLettered:1});expect((await admin.query("SELECT job.status,dead.reason_code,media.lifecycle_status FROM platform.jobs job JOIN platform.dead_letter_events dead ON dead.job_id=job.id JOIN platform.media_objects media ON media.id=job.id WHERE job.id=$1",[JOB])).rows[0]).toEqual({status:"dead_lettered",reason_code:"export_expired",lifecycle_status:"upload_pending"});const cleaned=await runPlatformMediaCleanupJobs(cleanupStore,{now:new Date(EXPIRES),run:["privateAttachmentRetention"]});expect(cleaned.runs[0]!.mutations[0]).toMatchObject({action:"delete-expired-financials-export"});expect(deleted).toHaveBeenCalledWith({bucket:"test-private",storageKey:`private/finance/financials-exports/${JOB}/${FINANCE_FOLIO_CSV_VERSION}.csv`});expect((await admin.query("SELECT job.job_type,event.event_type,audit.action FROM platform.jobs job JOIN platform.domain_events event ON event.id=job.source_domain_event_id JOIN platform.product_audit_events audit ON audit.job_id=job.id WHERE job.queue_name='platform.media.cleanup' AND job.property_id=$1",[PROPERTY])).rows[0]).toEqual({job_type:"platform.media.cleanup.expired-financials-export",event_type:"platform_media.financials_export.deleted_after_expiry",action:"platform_media.cleanup.expired_financials_export_deleted"});await cleanupStore.close();
    await cleanupJobs();await insertJob({status:"running",attempts:3,lockedAt:new Date(NOW.getTime()-301_000).toISOString()});
    await expect(runFinanceFolioExportJobs(pool,read,fakeWriter(),{exportId:JOB,clock:()=>NOW})).resolves.toMatchObject({deadLettered:1});
    const stale=(await admin.query("SELECT job_attempt_id IS NOT NULL attempt,failure_payload FROM platform.dead_letter_events WHERE job_id=$1",[JOB])).rows[0];expect(stale).toMatchObject({attempt:true,failure_payload:{lastAttemptAt:NOW.toISOString(),ownerPackage:"backend-events",replayEligible:true}});
    await cleanupJobs(); await insertJob({ status: "running", attempts: 3, lockedAt: ACCEPTED });
    await expect(runFinanceFolioExportJobs(pool, read, fakeWriter(), { exportId: JOB, clock: () => twelveHoursLate })).resolves.toMatchObject({ deadLettered: 1 });
    expect((await admin.query("SELECT job_metadata->>'lastErrorCode' code,(SELECT reason_code FROM platform.dead_letter_events WHERE job_id=platform.jobs.id) dead,(SELECT failure_payload->>'replayEligible' FROM platform.dead_letter_events WHERE job_id=platform.jobs.id) replay FROM platform.jobs WHERE id=$1", [JOB])).rows[0]).toEqual({ code: "export_expired", dead: "export_expired", replay: "false" });
  });

  function fakeWriter() { const writer: FinanceFolioExportArtifactWriter & { write: ReturnType<typeof vi.fn> } = { bucketName: "test-private", write: vi.fn(async ({ exportId, body, formatVersion }) => receipt(exportId,body,formatVersion)) }; return writer; }
  function receipt(exportId:string,body:string,formatVersion:string=FINANCE_FOLIO_CSV_VERSION){return{bucketName:"test-private",storageKey:`private/finance/financials-exports/${exportId}/${formatVersion}.csv`,checksumSha256:createHash("sha256").update(body).digest("hex"),sizeBytes:Buffer.byteLength(body)}}
  async function insertJob(options: { id?: string; status?: "pending"|"running"; attempts?: number; lockedAt?: string } = {}) { const id=options.id??JOB,snapshot={formatVersion:FINANCE_FOLIO_CSV_VERSION,propertyId:PROPERTY,currency:"EUR",filters:{sort:"createdAt_desc",state:"ready"},snapshotAt:SNAPSHOT_AT,manifest:[]},payload={commandId:COMMAND,organizationId:ORG,snapshot,expiresAt:EXPIRES},metadata={organizationId:ORG,actorUserId:ACTOR,responseEnvelope:{currency:"EUR"},acceptedAt:ACCEPTED,snapshotAt:SNAPSHOT_AT,expiresAt:EXPIRES,payloadFingerprint:hash(payload),manifestDigest:hash([]),formatVersion:FINANCE_FOLIO_CSV_VERSION,requestId:"request-vay-1134",causationId:CAUSE};await admin.query(`INSERT INTO platform.jobs(id,job_key,queue_name,job_type,status,attempts_count,max_attempts,run_after,locked_at,locked_by,tenant_scope,property_id,resource_product,resource_type,resource_id,correlation_id,payload,job_metadata) VALUES($1::uuid,$2,$3,$4,$5,$6,3,$7,$8,$9,'property',$10::uuid,'finance','financials_export',$1::text,'correlation-vay-1134',$11::jsonb,$12::jsonb)`,[id,`${FINANCE_FOLIO_EXPORT_JOB}:${PROPERTY}:test:${id}`,FINANCE_FOLIO_EXPORT_QUEUE,FINANCE_FOLIO_EXPORT_JOB,options.status??"pending",options.attempts??0,ACCEPTED,options.lockedAt??null,options.status==="running"?"old-worker":null,PROPERTY,JSON.stringify(payload),JSON.stringify(metadata)]);if(options.status==="running")await admin.query("INSERT INTO platform.job_attempts(job_id,attempt_number,status,worker_id,started_at) VALUES($1,$2,'running','old-worker',$3)",[id,options.attempts,options.lockedAt]); }
  async function insertExpenseJob(metadataFormatVersion:string=FINANCE_EXPENSE_CSV_VERSION){const snapshot={formatVersion:FINANCE_EXPENSE_CSV_VERSION,propertyId:PROPERTY,currency:"EUR",filters:{from:"2026-09-01",to:"2026-09-30",sort:"incurredOn_desc"},snapshotAt:SNAPSHOT_AT,manifest:[expenseSelection]},payload={commandId:COMMAND,organizationId:ORG,snapshot,expiresAt:EXPIRES},metadata={organizationId:ORG,actorUserId:ACTOR,responseEnvelope:{currency:"EUR"},acceptedAt:ACCEPTED,snapshotAt:SNAPSHOT_AT,expiresAt:EXPIRES,payloadFingerprint:hash(payload),manifestDigest:hash(snapshot.manifest),formatVersion:metadataFormatVersion,requestId:"request-vay-1134",causationId:CAUSE};await admin.query(`INSERT INTO platform.jobs(id,job_key,queue_name,job_type,status,max_attempts,run_after,tenant_scope,property_id,resource_product,resource_type,resource_id,correlation_id,payload,job_metadata) VALUES($1::uuid,$2,$3,$4,'pending',3,$5,'property',$6::uuid,'finance','financials_export',$1::text,'correlation-vay-1134',$7::jsonb,$8::jsonb)`,[JOB,`${FINANCE_EXPENSE_EXPORT_JOB}:${PROPERTY}:expense`,FINANCE_FOLIO_EXPORT_QUEUE,FINANCE_EXPENSE_EXPORT_JOB,ACCEPTED,PROPERTY,JSON.stringify(payload),JSON.stringify(metadata)]);}
  async function insertReportJob(snapshot: ReturnType<typeof profitLossSnapshot> | ReturnType<typeof revenueSnapshot> | ReturnType<typeof dashboardSnapshot>, jobType: string) {
    const payload = { commandId: COMMAND, organizationId: ORG, snapshot, expiresAt: EXPIRES };
    const metadata = { organizationId: ORG, actorUserId: ACTOR, responseEnvelope: { currency: "EUR" }, acceptedAt: ACCEPTED, snapshotAt: SNAPSHOT_AT, expiresAt: EXPIRES, payloadFingerprint: hash(payload), manifestDigest: hash(snapshot.manifest), formatVersion: snapshot.formatVersion, requestId: "request-vay-1134", causationId: CAUSE };
    await admin.query(`INSERT INTO platform.jobs(id,job_key,queue_name,job_type,status,max_attempts,run_after,tenant_scope,property_id,resource_product,resource_type,resource_id,correlation_id,payload,job_metadata) VALUES($1::uuid,$2,$3,$4,'pending',3,$5,'property',$6::uuid,'finance','financials_export',$1::text,'correlation-vay-1134',$7::jsonb,$8::jsonb)`, [JOB, `${jobType}:${PROPERTY}:report`, FINANCE_FOLIO_EXPORT_QUEUE, jobType, ACCEPTED, PROPERTY, JSON.stringify(payload), JSON.stringify(metadata)]);
  }
  async function insertOneShotDashboardJob(acceptedAt: Date) {
    const snapshot = dashboardSnapshot(), accepted = acceptedAt.toISOString(), expires = new Date(acceptedAt.getTime() + 86_400_000).toISOString();
    const payload = { commandId: COMMAND, organizationId: ORG, snapshot, expiresAt: expires };
    const metadata = { organizationId: ORG, actorUserId: ACTOR, responseEnvelope: { currency: "EUR" }, acceptedAt: accepted, snapshotAt: SNAPSHOT_AT, expiresAt: expires, payloadFingerprint: hash(payload), manifestDigest: hash(snapshot.manifest), formatVersion: snapshot.formatVersion, requestId: "request-vay-1134", causationId: CAUSE };
    await admin.query(`INSERT INTO platform.jobs(id,job_key,queue_name,job_type,status,max_attempts,run_after,tenant_scope,property_id,resource_product,resource_type,resource_id,correlation_id,payload,job_metadata) VALUES($1::uuid,$2,$3,$4,'pending',3,$5,'property',$6::uuid,'finance','financials_export',$1::text,'correlation-vay-1134',$7::jsonb,$8::jsonb)`, [JOB, `${FINANCE_DASHBOARD_EXPORT_JOB}:${PROPERTY}:one-shot`, FINANCE_FOLIO_EXPORT_QUEUE, FINANCE_DASHBOARD_EXPORT_JOB, accepted, PROPERTY, JSON.stringify(payload), JSON.stringify(metadata)]);
  }
  async function cleanupJobs(){await admin.query("BEGIN");try{await admin.query("SET LOCAL session_replication_role=replica");for(const sql of ["DELETE FROM platform.media_objects WHERE property_id=$1","DELETE FROM platform.product_audit_events WHERE property_id=$1","DELETE FROM platform.dead_letter_events WHERE property_id=$1","DELETE FROM platform.job_attempts WHERE job_id IN(SELECT id FROM platform.jobs WHERE property_id=$1)","DELETE FROM platform.jobs WHERE property_id=$1","DELETE FROM platform.domain_events WHERE property_id=$1","DELETE FROM platform.idempotency_keys WHERE property_id=$1"])await admin.query(sql,[PROPERTY]);await admin.query("COMMIT");}catch(error){await admin.query("ROLLBACK");throw error;}}
  async function cleanup(){await cleanupJobs();await admin.query("DELETE FROM pms.property_pricing_settings WHERE property_id=$1",[PROPERTY]);await admin.query("DELETE FROM identity.organization_resource_links WHERE resource_id=$1",[PROPERTY]);await admin.query("DELETE FROM identity.organization_memberships WHERE organization_id=$1",[ORG]);await admin.query("DELETE FROM platform.finance_export_worker_properties WHERE property_id=$1",[PROPERTY]);await admin.query("DELETE FROM hotel_catalog.properties WHERE id=$1",[PROPERTY]);await admin.query("DELETE FROM identity.organizations WHERE id=$1",[ORG]);await admin.query("DELETE FROM identity.users WHERE id=$1",[ACTOR]);}
  async function provisionWorker(){const database=(await admin.query("SELECT current_database() AS name")).rows[0].name.replaceAll('"','""');await admin.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${FINANCE_EXPORT_WORKER_ROLE}') THEN CREATE ROLE ${FINANCE_EXPORT_WORKER_ROLE} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$; ALTER ROLE ${FINANCE_EXPORT_WORKER_ROLE} PASSWORD 'finance-export-test'; REVOKE TEMP ON DATABASE "${database}" FROM PUBLIC; GRANT CONNECT ON DATABASE "${database}" TO ${FINANCE_EXPORT_WORKER_ROLE}; GRANT USAGE ON SCHEMA platform,finance,hotel_catalog,pms TO ${FINANCE_EXPORT_WORKER_ROLE}`);for(const [table,privileges] of Object.entries(financeExportWorkerPrivileges))for(const [kind,columns] of Object.entries(privileges))await admin.query(`GRANT ${kind}${columns===true?"":`(${columns.join(",")})`} ON ${table} TO ${FINANCE_EXPORT_WORKER_ROLE}`);}
});

const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
