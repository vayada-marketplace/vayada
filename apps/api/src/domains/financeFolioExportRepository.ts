import { createHash, randomUUID } from "node:crypto";
// prettier-ignore
import { FINANCE_DASHBOARD_CSV_VERSION, FINANCE_EXPENSE_CSV_VERSION, FINANCE_FOLIO_CSV_CONTENT_TYPE, FINANCE_FOLIO_CSV_VERSION, FINANCE_PROFIT_LOSS_CSV_VERSION, FINANCE_REVENUE_CSV_VERSION, parseFinanceDashboardExportSnapshot, parseFinanceDashboardQuery, parseFinanceExpenseExportQuery, parseFinanceExpenseExportSnapshot, parseFinanceFolioExportFilters, parseFinanceFolioExportSnapshot, parseFinanceProfitLossExportSnapshot, parseFinanceProfitLossQuery, parseFinanceRevenueExportSnapshot, parseFinanceRevenueQuery, type FinanceDashboardExportSnapshot, type FinanceDashboardQuery, type FinanceExpenseEnvelope, type FinanceExpenseExportQuery, type FinanceExpenseExportSnapshot, type FinanceFolioEnvelope, type FinanceFolioExportFilters, type FinanceFolioExportSnapshot, type FinanceProfitLossExportSnapshot, type FinanceProfitLossQuery, type FinanceReportingEnvelope, type FinanceRevenueExportSnapshot, type FinanceRevenueQuery } from "@vayada/domain-finance";
import pg, { type PoolClient } from "pg";
export const FINANCE_FOLIO_EXPORT_QUEUE = "finance.financials-exports";
export const FINANCE_FOLIO_EXPORT_JOB = "finance.folio-csv-export.v1";
export const FINANCE_EXPENSE_EXPORT_JOB = "finance.expense-csv-export.v1";
export const FINANCE_PROFIT_LOSS_EXPORT_JOB = "finance.profit-loss-csv-export.v1";
export const FINANCE_REVENUE_EXPORT_JOB = "finance.revenue-csv-export.v1";
export const FINANCE_DASHBOARD_EXPORT_JOB = "finance.dashboard-csv-export.v1";
export const FINANCE_FOLIO_EXPORT_TTL_MS = 24 * 60 * 60 * 1_000;
const FOLIO_OPERATION = "financials.folio_export.create.v1";
const EXPENSE_OPERATION = "financials.expense_export.create.v1";
const PROFIT_LOSS_OPERATION = "financials.profit_loss_export.create.v1";
const REVENUE_OPERATION = "financials.revenue_export.create.v1";
const DASHBOARD_OPERATION = "financials.dashboard_export.create.v1";
// prettier-ignore
export type FinanceFolioExportAudit = { actorUserId: string; requestId: string; correlationId: string; causationId: string; requestedAt: string };
// prettier-ignore
export type FinanceFolioExportJobPayload = { commandId: string; organizationId: string; snapshot: FinanceFolioExportSnapshot; expiresAt: string };
// prettier-ignore
export type FinanceExpenseExportJobPayload = { commandId: string; organizationId: string; snapshot: FinanceExpenseExportSnapshot; expiresAt: string };
export type FinanceProfitLossExportJobPayload = {
  commandId: string;
  organizationId: string;
  snapshot: FinanceProfitLossExportSnapshot;
  expiresAt: string;
};
export type FinanceRevenueExportJobPayload = {
  commandId: string;
  organizationId: string;
  snapshot: FinanceRevenueExportSnapshot;
  expiresAt: string;
};
export type FinanceDashboardExportJobPayload = {
  commandId: string;
  organizationId: string;
  snapshot: FinanceDashboardExportSnapshot;
  expiresAt: string;
};
export type FinanceExportJobPayload =
  | FinanceFolioExportJobPayload
  | FinanceExpenseExportJobPayload
  | FinanceProfitLossExportJobPayload
  | FinanceRevenueExportJobPayload
  | FinanceDashboardExportJobPayload;
// prettier-ignore
export type FinanceExportEnqueueResult = { status: "created" | "replayed"; exportId: string; envelope: FinanceFolioEnvelope | FinanceExpenseEnvelope | FinanceReportingEnvelope } | { status: "conflict" };
// prettier-ignore
export type FinanceFolioExportCommand = { commandId: string; idempotencyKey: string; organizationId: string; propertyId: string; currency: string; filters: FinanceFolioExportFilters; snapshot: FinanceFolioExportSnapshot; envelope: FinanceFolioEnvelope; audit: FinanceFolioExportAudit };
// prettier-ignore
export type FinanceExpenseExportCommand = { commandId: string; idempotencyKey: string; organizationId: string; propertyId: string; currency: string; filters: FinanceExpenseExportQuery; snapshot: FinanceExpenseExportSnapshot; envelope: FinanceExpenseEnvelope; audit: FinanceFolioExportAudit };
export type FinanceProfitLossExportCommand = {
  commandId: string;
  idempotencyKey: string;
  organizationId: string;
  propertyId: string;
  currency: string;
  filters: FinanceProfitLossQuery;
  snapshot: FinanceProfitLossExportSnapshot;
  envelope: FinanceReportingEnvelope;
  audit: FinanceFolioExportAudit;
};
export type FinanceRevenueExportCommand = {
  commandId: string;
  idempotencyKey: string;
  organizationId: string;
  propertyId: string;
  currency: string;
  filters: FinanceRevenueQuery;
  snapshot: FinanceRevenueExportSnapshot;
  envelope: FinanceReportingEnvelope;
  audit: FinanceFolioExportAudit;
};
export type FinanceDashboardExportCommand = {
  commandId: string;
  idempotencyKey: string;
  organizationId: string;
  propertyId: string;
  currency: string;
  filters: FinanceDashboardQuery;
  snapshot: FinanceDashboardExportSnapshot;
  envelope: FinanceReportingEnvelope;
  audit: FinanceFolioExportAudit;
};
export type FinanceExportCommand =
  | FinanceFolioExportCommand
  | FinanceExpenseExportCommand
  | FinanceProfitLossExportCommand
  | FinanceRevenueExportCommand
  | FinanceDashboardExportCommand;
// prettier-ignore
export type FinanceFolioExportStatus = { state:"pending"|"running"|"failed"|"expired"; expiresAt:string } | { state:"ready"; expiresAt:string; artifact:{ mediaId:string; bucketName:string; storageKey:string; visibility:"private"; lifecycleStatus:"active"; filename:string; contentType:string; sizeBytes:number } };
// prettier-ignore
type ExpectedPayload = { organizationId: string; propertyId: string; currency: string; payloadFingerprint: string; acceptedAt: string; snapshotAt: string; expiresAt: string; now: Date };
// prettier-ignore
type MacPort = { generateMac(input: { KeyId: string; MacAlgorithm: "HMAC_SHA_256"; Message: Uint8Array }): Promise<{ Mac?: Uint8Array }> };

// prettier-ignore
export function createPgFinanceFolioExportJobRepository(config: { connectionString?: string; pool?: pg.Pool; searchDigest(domain: "folio" | "expense", search: string): Promise<string> }) {
  if (!config.pool && !config.connectionString?.trim())
    throw new Error("Finance folio export jobs require a connection string");
  if (typeof config.searchDigest !== "function")
    throw new Error("Finance folio export jobs require a search digester");
  const pool = config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: 3 });
  return {
    async find(input: { exportId:string; organizationId:string; propertyId:string; now:Date }): Promise<FinanceFolioExportStatus|null> {
      if (![input.exportId,input.organizationId,input.propertyId].every(uuid) || !Number.isFinite(input.now.getTime())) throw new TypeError("Invalid folio export lookup");
      const row=(await pool.query<{status:string;jobType:string;expiresAt:string;formatVersion:string;asOf:string|null;year:string|null;from:string|null;to:string|null;mediaId:string|null;bucketName:string|null;storageKey:string|null;visibility:string|null;lifecycleStatus:string|null;filename:string|null;contentType:string|null;sizeBytes:number|null;retainedUntil:string|null}>(`SELECT job.status,job.job_type AS "jobType",job.job_metadata->>'expiresAt' AS "expiresAt",job.job_metadata->>'formatVersion' AS "formatVersion",job.payload->'snapshot'->>'asOf' AS "asOf",job.payload->'snapshot'->'filters'->>'year' AS year,job.payload->'snapshot'->'filters'->>'from' AS "from",job.payload->'snapshot'->'filters'->>'to' AS "to",media.id::text AS "mediaId",media.bucket AS "bucketName",media.storage_key AS "storageKey",media.visibility,media.lifecycle_status AS "lifecycleStatus",media.original_filename AS filename,media.content_type AS "contentType",media.size_bytes::int AS "sizeBytes",to_char(media.retained_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "retainedUntil"
        FROM platform.jobs job LEFT JOIN platform.media_objects media ON media.id=job.id AND media.owner_organization_id=$3::uuid AND media.property_id=$2::uuid AND media.storage_kind='vayada_managed' AND media.purpose='finance.financials_export' AND media.resource_product='finance' AND media.resource_type='financials_export' AND media.resource_id=job.id::text AND media.source_system='platform' AND media.source_table='platform.jobs' AND media.source_row_id=job.id::text
        WHERE job.id=$1::uuid AND job.property_id=$2::uuid AND job.tenant_scope='property'
          AND job.queue_name=$4 AND job.job_type IN ($5,$6,$7,$8,$9) AND job.resource_product='finance'
          AND job.resource_type='financials_export' AND job.resource_id=job.id::text
          AND job.payload->>'organizationId'=$3::text AND job.job_metadata->>'organizationId'=$3::text`,[input.exportId,input.propertyId,input.organizationId,FINANCE_FOLIO_EXPORT_QUEUE,FINANCE_FOLIO_EXPORT_JOB,FINANCE_EXPENSE_EXPORT_JOB,FINANCE_PROFIT_LOSS_EXPORT_JOB,FINANCE_REVENUE_EXPORT_JOB,FINANCE_DASHBOARD_EXPORT_JOB])).rows[0];
      if (!row) return null;
      if (!instant(row.expiresAt)) throw new Error("Finance folio export status evidence is invalid");
      if (!["pending","running","failed","canceled","dead_lettered","succeeded"].includes(row.status)) throw new Error("Finance folio export status evidence is invalid");
      if (input.now.getTime()>=new Date(row.expiresAt).getTime()) return {state:"expired",expiresAt:row.expiresAt};
      if (row.status==="pending"||row.status==="running") return {state:row.status,expiresAt:row.expiresAt};
      if (["failed","canceled","dead_lettered"].includes(row.status)) return {state:"failed",expiresAt:row.expiresAt};
      const shape=exportShape(row.jobType,row.formatVersion,input.propertyId,input.exportId,row.year,row.asOf,row.from,row.to);
      if (!shape) throw new Error("Finance export status evidence is invalid");
      const {filename,storageKey}=shape;
      if (row.status!=="succeeded"||row.mediaId!==input.exportId||!trimmed(row.bucketName,1,200)||row.storageKey!==storageKey||row.visibility!=="private"||row.lifecycleStatus!=="active"||row.filename!==filename||row.contentType!==FINANCE_FOLIO_CSV_CONTENT_TYPE||!Number.isSafeInteger(row.sizeBytes)||row.sizeBytes===null||row.sizeBytes<=0||row.retainedUntil!==row.expiresAt) throw new Error("Finance folio export status evidence is invalid");
      return {state:"ready",expiresAt:row.expiresAt,artifact:{mediaId:row.mediaId,bucketName:row.bucketName,storageKey:row.storageKey,visibility:"private",lifecycleStatus:"active",filename:row.filename,contentType:row.contentType,sizeBytes:row.sizeBytes}};
    },
    async enqueue(input: FinanceExportCommand): Promise<FinanceExportEnqueueResult> {
      const evidence = exportEvidence(input);
      if (!evidence || !validCommand(input, evidence.filters, evidence.snapshot))
        throw new TypeError("Invalid finance export command");
      const { auditAction, filters, jobType, operation, snapshot } = evidence;
      const keyHash = hash(input.idempotencyKey);
      // prettier-ignore
      const requestFingerprint = hash(JSON.stringify([input.commandId, input.organizationId, input.propertyId, filters]));
      return transaction(pool, async (client) => {
        if (!(await authorizedScope(client, input))) throw new TypeError("Invalid folio export command");
        const exportId = randomUUID();
        const inserted = await client.query<{ acceptedAt: string; expiresAt: string }>(
          `INSERT INTO platform.idempotency_keys
            (id,operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,
             property_id,response_status_code,response_resource_product,response_resource_type,
             response_resource_id,correlation_id,completed_at,expires_at,idempotency_metadata)
           VALUES($1::uuid,'finance',$2,$3,$4,'completed','property',$5::uuid,202,'finance',
             'financials_export',$1::text,$6,date_trunc('milliseconds',statement_timestamp()),
             date_trunc('milliseconds',statement_timestamp())+interval '24 hours',$7::jsonb)
           ON CONFLICT(operation_scope,operation,key_hash,scope_key) DO NOTHING RETURNING
             to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "acceptedAt",
             to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"`,
          // prettier-ignore
          [exportId, operation, keyHash, requestFingerprint, input.propertyId, input.audit.correlationId, JSON.stringify({ commandId: input.commandId, organizationId: input.organizationId })],
        );
        if (!inserted.rowCount) {
          const prior = (
            await client.query<{ fingerprint: string; exportId: string; envelope: FinanceFolioEnvelope | FinanceExpenseEnvelope | FinanceReportingEnvelope }>(
              `SELECT i.request_fingerprint_hash AS fingerprint,i.response_resource_id AS "exportId",
                 j.job_metadata->'responseEnvelope' AS envelope
               FROM platform.idempotency_keys i JOIN platform.jobs j
                 ON j.id::text=i.response_resource_id AND j.property_id=i.property_id
               WHERE i.operation_scope='finance' AND i.operation=$1 AND i.key_hash=$2
                 AND i.tenant_scope='property' AND i.property_id=$3::uuid AND i.status='completed'
                 AND i.expires_at>statement_timestamp() AND i.response_resource_product='finance'
                 AND i.response_resource_type='financials_export' AND j.queue_name=$4 AND j.job_type=$5
                 AND j.resource_product='finance' AND j.resource_type='financials_export'
               FOR UPDATE OF i`,
              // prettier-ignore
              [operation, keyHash, input.propertyId, FINANCE_FOLIO_EXPORT_QUEUE, jobType],
            )
          ).rows[0];
          return prior?.fingerprint === requestFingerprint && uuid(prior.exportId)
            ? { status: "replayed", exportId: prior.exportId, envelope: prior.envelope }
            : { status: "conflict" };
        }
        const { acceptedAt, expiresAt } = inserted.rows[0]!;
        if (new Date(snapshot.snapshotAt).getTime() > new Date(acceptedAt).getTime())
          throw new TypeError("Invalid folio export command");
        const redactedPayload = await redacted(
          config.searchDigest,
          input.currency,
          filters,
          snapshot,
        );
        // prettier-ignore
        const payload = exportPayload(input.commandId, input.organizationId, snapshot, expiresAt);
        const payloadFingerprint = hash(JSON.stringify(payload));
        // Private jobs carry the raw filter search; audit evidence carries only its digest below.
        // prettier-ignore
        const lineage = { actorUserId: input.audit.actorUserId, organizationId: input.organizationId, requestId: input.audit.requestId, correlationId: input.audit.correlationId, causationId: input.audit.causationId, requestedAt: input.audit.requestedAt };
        // prettier-ignore
        const jobMetadata = { acceptedAt, expiresAt, formatVersion: snapshot.formatVersion, manifestDigest: hash(JSON.stringify(snapshot.manifest)), payloadFingerprint, responseEnvelope: input.envelope, snapshotAt: snapshot.snapshotAt, ...lineage };
        await client.query(
          `INSERT INTO platform.jobs
            (id,job_key,queue_name,job_type,status,max_attempts,tenant_scope,property_id,
             resource_product,resource_type,resource_id,correlation_id,idempotency_key_hash,
             payload,job_metadata)
           VALUES($1::uuid,$2,$3,$4,'pending',3,'property',$5::uuid,'finance',
             'financials_export',$1::text,$6,$7,$8::jsonb,$9::jsonb)`,
          // prettier-ignore
          [exportId, `${jobType}:${input.propertyId}:${keyHash}`, FINANCE_FOLIO_EXPORT_QUEUE, jobType, input.propertyId, input.audit.correlationId, keyHash, JSON.stringify(payload), JSON.stringify(jobMetadata)],
        );
        await client.query(
          `INSERT INTO platform.product_audit_events
            (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,
             actor_user_id,target_resource_product,target_resource_type,target_resource_id,
             job_id,idempotency_key_id,correlation_id,causation_id,redacted_payload,
             audit_metadata,retention_class,privacy_scope)
           VALUES($1,'finance',$9,$2::timestamptz,'property',$3::uuid,
             'user',$4::uuid,'finance','financials_export',$5::text,$5::uuid,$5::uuid,$6,$7,
             $8::jsonb,$10::jsonb,'financial','confidential')`,
          // prettier-ignore
          [`finance.financials-export:${exportId}:requested`, acceptedAt, input.propertyId, input.audit.actorUserId, exportId, input.audit.correlationId, input.audit.causationId, JSON.stringify(redactedPayload), auditAction, JSON.stringify({ organizationId: input.organizationId, requestId: input.audit.requestId, requestedAt: input.audit.requestedAt })],
        );
        return { status: "created", exportId, envelope: input.envelope };
      });
    },
    async close() {
      if (!config.pool) await pool.end();
    },
  };
}

export function createKmsFinanceFolioExportSearchDigest(config: { kms: MacPort; keyArn: string }) {
  if (!config.keyArn.trim())
    throw new Error("Finance folio export search digest requires a KMS key");
  return async (domain: "folio" | "expense", search: string) => {
    const result = await config.kms.generateMac({
      KeyId: config.keyArn,
      MacAlgorithm: "HMAC_SHA_256",
      Message: Buffer.from(`finance-${domain}-export-search-v1\0${search}`),
    });
    if (!result.Mac || result.Mac.byteLength !== 32)
      throw new Error("Finance folio export search digest failed");
    return Buffer.from(result.Mac).toString("hex");
  };
}
// prettier-ignore
export function parseFinanceFolioExportJobPayload(value: unknown, expected: ExpectedPayload): FinanceFolioExportJobPayload {
  const payload=parseFinanceExportJobPayload(value,expected);
  if(payload.snapshot.formatVersion!==FINANCE_FOLIO_CSV_VERSION) throw new TypeError("Finance folio export job payload is invalid");
  return {commandId:payload.commandId,organizationId:payload.organizationId,snapshot:payload.snapshot,expiresAt:payload.expiresAt};
}

// prettier-ignore
export function parseFinanceExportJobPayload(value: unknown, expected: ExpectedPayload): FinanceExportJobPayload {
  const row = object(value), raw=object(row.snapshot), snapshot = raw.formatVersion===FINANCE_EXPENSE_CSV_VERSION ? parseFinanceExpenseExportSnapshot(raw) : raw.formatVersion===FINANCE_PROFIT_LOSS_CSV_VERSION ? parseFinanceProfitLossExportSnapshot(raw) : raw.formatVersion===FINANCE_REVENUE_CSV_VERSION ? parseFinanceRevenueExportSnapshot(raw) : raw.formatVersion===FINANCE_DASHBOARD_CSV_VERSION ? parseFinanceDashboardExportSnapshot(raw) : parseFinanceFolioExportSnapshot(raw);
  if (
    Object.keys(row).length !== 4 ||
    !uuid(row.commandId) ||
    !uuid(row.organizationId) ||
    !snapshot ||
    snapshot.propertyId !== expected.propertyId ||
    snapshot.currency !== expected.currency ||
    row.organizationId !== expected.organizationId ||
    !validWindow(row, snapshot, expected)
  )
    throw new TypeError("Finance export job payload is invalid");
  const payload = {commandId:row.commandId,organizationId:row.organizationId,snapshot,expiresAt:String(row.expiresAt)} as FinanceExportJobPayload;
  if (hash(JSON.stringify(payload)) !== expected.payloadFingerprint)
    throw new TypeError("Finance export job payload is invalid");
  return payload;
}

async function authorizedScope(client: PoolClient, input: FinanceExportCommand) {
  const result = await client.query(
    `SELECT 1 FROM hotel_catalog.properties property
     JOIN identity.organizations organization ON organization.id=$1::uuid AND organization.kind='hotel_group' AND organization.status='active'
     JOIN identity.organization_memberships membership ON membership.organization_id=organization.id
       AND membership.user_id=$3::uuid AND membership.status='active'
     JOIN identity.users actor ON actor.id=membership.user_id AND actor.status='active'
     JOIN identity.organization_resource_links resource ON resource.organization_id=organization.id
       AND resource.product='pms' AND resource.resource_type='pms_property'
       AND resource.resource_id=property.id::text AND resource.relationship IN ('owner','finance_manager')
       AND resource.status='active'
     WHERE property.id=$2::uuid
     FOR KEY SHARE OF property
     FOR SHARE OF organization,membership,actor,resource`,
    [input.organizationId, input.propertyId, input.audit.actorUserId],
  );
  return (result.rowCount ?? 0) > 0;
}
// prettier-ignore
function validCommand(input: FinanceExportCommand, filters: FinanceFolioExportFilters | FinanceExpenseExportQuery | FinanceProfitLossQuery | FinanceRevenueQuery | FinanceDashboardQuery, snapshot: FinanceFolioExportSnapshot | FinanceExpenseExportSnapshot | FinanceProfitLossExportSnapshot | FinanceRevenueExportSnapshot | FinanceDashboardExportSnapshot) {
  return (
    uuid(input.commandId) &&
    uuid(input.organizationId) &&
    uuid(input.propertyId) &&
    /^[A-Z]{3}$/.test(input.currency) &&
    trimmed(input.idempotencyKey, 8, 200) &&
    snapshot.propertyId === input.propertyId &&
    snapshot.currency === input.currency &&
    input.envelope.propertyId === input.propertyId &&
    input.envelope.currency === input.currency &&
    ((snapshot.formatVersion !== FINANCE_PROFIT_LOSS_CSV_VERSION && snapshot.formatVersion !== FINANCE_REVENUE_CSV_VERSION && snapshot.formatVersion !== FINANCE_DASHBOARD_CSV_VERSION) ||
      (input.envelope.contractVersion === "pms-financials.v1" &&
        input.envelope.generatedAt === snapshot.snapshotAt &&
        input.envelope.timeZone === snapshot.timeZone)) &&
    JSON.stringify(snapshot.filters) === JSON.stringify(filters) &&
    uuid(input.audit.actorUserId) &&
    trimmed(input.audit.requestId, 1, 200) &&
    trimmed(input.audit.correlationId, 1, 200) &&
    uuid(input.audit.causationId) &&
    instant(input.audit.requestedAt)
  );
}

// prettier-ignore
function validWindow(row: Record<string, unknown>, snapshot: {snapshotAt:string}, expected: ExpectedPayload) {
  const accepted = instantMillis(expected.acceptedAt),
    expires = instantMillis(expected.expiresAt),
    payloadExpires = instantMillis(row.expiresAt);
  return (
    uuid(expected.organizationId) &&
    uuid(expected.propertyId) &&
    /^[A-Z]{3}$/.test(expected.currency) &&
    /^[0-9a-f]{64}$/.test(expected.payloadFingerprint) &&
    Number.isFinite(expected.now.getTime()) &&
    snapshot.snapshotAt === expected.snapshotAt &&
    row.expiresAt === expected.expiresAt &&
    accepted !== null &&
    expires !== null &&
    payloadExpires === expires &&
    new Date(snapshot.snapshotAt).getTime() <= accepted &&
    expires - accepted === FINANCE_FOLIO_EXPORT_TTL_MS &&
    expected.now.getTime() < expires
  );
}

// prettier-ignore
async function redacted(searchDigest: (domain: "folio" | "expense", search: string) => Promise<string>, currency: string, filters: FinanceFolioExportFilters | FinanceExpenseExportQuery | FinanceProfitLossQuery | FinanceRevenueQuery | FinanceDashboardQuery, snapshot: FinanceFolioExportSnapshot | FinanceExpenseExportSnapshot | FinanceProfitLossExportSnapshot | FinanceRevenueExportSnapshot | FinanceDashboardExportSnapshot) {
  const search = "search" in filters ? filters.search : undefined;
  const safe = "search" in filters ? Object.fromEntries(Object.entries(filters).filter(([key])=>key!=="search")) : filters;
  const domain = snapshot.formatVersion===FINANCE_EXPENSE_CSV_VERSION ? "expense" : "folio";
  const searchHash = search ? await searchDigest(domain, search) : undefined;
  if (searchHash && !/^[0-9a-f]{64}$/.test(searchHash)) throw new Error("Finance folio export search digest failed");
  return {
    currency,
    filters: {
      ...safe,
      ...(snapshot.formatVersion === FINANCE_PROFIT_LOSS_CSV_VERSION || snapshot.formatVersion === FINANCE_REVENUE_CSV_VERSION || snapshot.formatVersion === FINANCE_DASHBOARD_CSV_VERSION ? {} : { searchPresent: Boolean(search), ...(searchHash ? { searchHash } : {}) }),
    },
    formatVersion: snapshot.formatVersion,
    manifestCount: snapshot.manifest.length,
    manifestDigest: hash(JSON.stringify(snapshot.manifest)),
  };
}

// prettier-ignore
function exportEvidence(input: FinanceExportCommand) {
  if (input.snapshot.formatVersion === FINANCE_EXPENSE_CSV_VERSION) {
    const filters=parseFinanceExpenseExportQuery(input.filters),snapshot=parseFinanceExpenseExportSnapshot(input.snapshot);
    return filters&&snapshot ? {filters,snapshot,operation:EXPENSE_OPERATION,jobType:FINANCE_EXPENSE_EXPORT_JOB,auditAction:"finance.expense_export.requested"} : null;
  }
  if (input.snapshot.formatVersion === FINANCE_PROFIT_LOSS_CSV_VERSION) {
    const filters=parseFinanceProfitLossQuery(input.filters),snapshot=parseFinanceProfitLossExportSnapshot(input.snapshot);
    return filters&&snapshot ? {filters,snapshot,operation:PROFIT_LOSS_OPERATION,jobType:FINANCE_PROFIT_LOSS_EXPORT_JOB,auditAction:"finance.profit_loss_export.requested"} : null;
  }
  if (input.snapshot.formatVersion === FINANCE_REVENUE_CSV_VERSION) {
    const filters=parseFinanceRevenueQuery(input.filters),snapshot=parseFinanceRevenueExportSnapshot(input.snapshot);
    return filters&&snapshot ? {filters,snapshot,operation:REVENUE_OPERATION,jobType:FINANCE_REVENUE_EXPORT_JOB,auditAction:"finance.revenue_export.requested"} : null;
  }
  if (input.snapshot.formatVersion === FINANCE_DASHBOARD_CSV_VERSION) {
    const requested=parseFinanceDashboardQuery(input.filters),snapshot=parseFinanceDashboardExportSnapshot(input.snapshot);
    const filters=requested&&snapshot ? {asOf:requested.asOf??snapshot.asOf} : null;
    return filters&&snapshot ? {filters,snapshot,operation:DASHBOARD_OPERATION,jobType:FINANCE_DASHBOARD_EXPORT_JOB,auditAction:"finance.dashboard_export.requested"} : null;
  }
  const filters=parseFinanceFolioExportFilters(input.filters),snapshot=parseFinanceFolioExportSnapshot(input.snapshot);
  return filters&&snapshot ? {filters,snapshot,operation:FOLIO_OPERATION,jobType:FINANCE_FOLIO_EXPORT_JOB,auditAction:"finance.folio_export.requested"} : null;
}

// prettier-ignore
function exportPayload(commandId:string,organizationId:string,snapshot:FinanceFolioExportSnapshot|FinanceExpenseExportSnapshot|FinanceProfitLossExportSnapshot|FinanceRevenueExportSnapshot|FinanceDashboardExportSnapshot,expiresAt:string):FinanceExportJobPayload {
  return {commandId,organizationId,snapshot,expiresAt} as FinanceExportJobPayload;
}

async function transaction<T>(pool: pg.Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const instant = (value: unknown): value is string => instantMillis(value) !== null;
function instantMillis(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) && new Date(millis).toISOString() === value ? millis : null;
}
const trimmed = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" && value === value.trim() && value.length >= min && value.length <= max;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Finance folio export job payload is invalid");
  return value as Record<string, unknown>;
}
function exportShape(
  jobType: string,
  formatVersion: string,
  propertyId: string,
  exportId: string,
  year: string | null,
  asOf: string | null,
  from: string | null,
  to: string | null,
) {
  const storageKey = `private/finance/financials-exports/${exportId}/${formatVersion}.csv`;
  if (jobType === FINANCE_FOLIO_EXPORT_JOB && formatVersion === FINANCE_FOLIO_CSV_VERSION)
    return { filename: `pms-financials-folios-${propertyId}.csv`, storageKey };
  if (jobType === FINANCE_EXPENSE_EXPORT_JOB && formatVersion === FINANCE_EXPENSE_CSV_VERSION)
    return { filename: `pms-financials-expenses-${propertyId}.csv`, storageKey };
  if (
    jobType === FINANCE_PROFIT_LOSS_EXPORT_JOB &&
    formatVersion === FINANCE_PROFIT_LOSS_CSV_VERSION &&
    typeof year === "string" &&
    /^[1-9]\d{3}$/.test(year) &&
    typeof asOf === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(asOf)
  )
    return { filename: `pms-financials-profit-loss-${propertyId}-${year}-${asOf}.csv`, storageKey };
  if (jobType === FINANCE_REVENUE_EXPORT_JOB && formatVersion === FINANCE_REVENUE_CSV_VERSION)
    return parseFinanceRevenueQuery({ from, to })
      ? { filename: `pms-financials-revenue-${propertyId}-${from}-${to}.csv`, storageKey }
      : null;
  if (jobType === FINANCE_DASHBOARD_EXPORT_JOB && formatVersion === FINANCE_DASHBOARD_CSV_VERSION)
    return parseFinanceDashboardQuery({ asOf })
      ? { filename: `pms-financials-dashboard-${propertyId}-${asOf}.csv`, storageKey }
      : null;
  return null;
}
