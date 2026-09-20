import { createHash } from "node:crypto";
import {
  FINANCE_EXPENSE_CSV_CONTENT_TYPE,
  FINANCE_EXPENSE_CSV_VERSION,
  FINANCE_FOLIO_CSV_CONTENT_TYPE,
  FINANCE_FOLIO_CSV_VERSION,
  FINANCE_PROFIT_LOSS_CSV_CONTENT_TYPE,
  FINANCE_PROFIT_LOSS_CSV_VERSION,
  buildFinanceProfitLossCsvArtifact,
  type FinanceExpenseExportSnapshot,
  type FinanceFolioCsvArtifact,
  type FinanceFolioExportSnapshot,
  type FinanceProfitLossCsvArtifact,
  type FinanceProfitLossExportSnapshot,
} from "@vayada/domain-finance";
import type pg from "pg";

import {
  FINANCE_EXPENSE_EXPORT_JOB,
  FINANCE_FOLIO_EXPORT_JOB,
  FINANCE_FOLIO_EXPORT_QUEUE,
  FINANCE_PROFIT_LOSS_EXPORT_JOB,
  parseFinanceExportJobPayload,
} from "../domains/financeFolioExportRepository.js";
import {
  FinanceExpenseEvidenceError,
  type FinanceExpenseExportArtifact,
  type FinanceExpenseReadModel,
} from "../domains/financeExpenseReadModel.js";
import {
  FinanceFolioEvidenceError,
  type FinanceFolioReadRepository,
} from "../domains/financeFolioReadRepository.js";
import type {
  FinanceFolioExportArtifact,
  FinanceFolioExportArtifactWriter,
} from "../platform/financeFolioExportArtifacts.js";

// prettier-ignore
type Job = { id:string; jobType:string; propertyId:string; resourceType:string; resourceId:string; correlationId:string; idempotencyKeyHash:string; attemptsCount:number; maxAttempts:number; status:"pending"|"running"; payload:unknown; organizationId:string; actorUserId:string; currency:string; acceptedAt:string; snapshotAt:string; expiresAt:string; payloadFingerprint:string; manifestDigest:string; formatVersion:string; requestId:string; causationId:string };
type Options = { workerId?: string; limit?: number; clock?: () => Date; random?: () => number };
type FinanceExportRead = Pick<FinanceFolioReadRepository, "exportReady"> &
  Pick<FinanceExpenseReadModel, "exportCsv">;
type FinanceCsvArtifact =
  | FinanceFolioCsvArtifact
  | FinanceExpenseExportArtifact
  | FinanceProfitLossCsvArtifact;
// prettier-ignore
export type FinanceFolioExportCounters = { succeeded:number; retryScheduled:number; deadLettered:number };

// prettier-ignore
export async function runFinanceFolioExportJobs(pool: pg.Pool, read: FinanceExportRead, writer: FinanceFolioExportArtifactWriter, options: Options = {}): Promise<FinanceFolioExportCounters> {
  const counters: FinanceFolioExportCounters = { succeeded: 0, retryScheduled: 0, deadLettered: 0 };
  for (let index = 0; index < (options.limit ?? 10); index++) {
    const outcome = await runOne(pool, read, writer, options);
    if (!outcome) break;
    counters[outcome]++;
  }
  return counters;
}

// Registry intent commits before S3 I/O, so a crash can never orphan an undiscoverable object.
// prettier-ignore
async function runOne(pool: pg.Pool, read: FinanceExportRead, writer: FinanceFolioExportArtifactWriter, options: Options): Promise<keyof FinanceFolioExportCounters | null> {
  const client = await pool.connect(), clock = options.clock ?? (() => new Date()), now = clock(), workerId = options.workerId ?? `finance-export:${process.pid}`;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='45s'");
    const job = (await client.query<Job>(`SELECT id::text,job_type AS "jobType",property_id::text AS "propertyId",resource_type AS "resourceType",resource_id AS "resourceId",correlation_id AS "correlationId",idempotency_key_hash AS "idempotencyKeyHash",attempts_count::int AS "attemptsCount",max_attempts::int AS "maxAttempts",status,payload,job_metadata->>'organizationId' AS "organizationId",job_metadata->>'actorUserId' AS "actorUserId",job_metadata->'responseEnvelope'->>'currency' AS currency,job_metadata->>'acceptedAt' AS "acceptedAt",job_metadata->>'snapshotAt' AS "snapshotAt",job_metadata->>'expiresAt' AS "expiresAt",job_metadata->>'payloadFingerprint' AS "payloadFingerprint",job_metadata->>'manifestDigest' AS "manifestDigest",job_metadata->>'formatVersion' AS "formatVersion",job_metadata->>'requestId' AS "requestId",job_metadata->>'causationId' AS "causationId"
      FROM platform.jobs WHERE queue_name=$1 AND job_type IN ($2,$3,$5) AND tenant_scope='property' AND property_id IS NOT NULL AND attempts_count<=max_attempts AND ((status='pending' AND run_after<=$4::timestamptz AND attempts_count<max_attempts) OR (status='running' AND locked_at<$4::timestamptz-interval '5 minutes')) ORDER BY priority DESC,run_after,created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [FINANCE_FOLIO_EXPORT_QUEUE, FINANCE_FOLIO_EXPORT_JOB, FINANCE_EXPENSE_EXPORT_JOB, now.toISOString(), FINANCE_PROFIT_LOSS_EXPORT_JOB])).rows[0];
    if (!job) { await client.query("COMMIT"); return null; }
    if (job.status === "running") {
      const stale = (await client.query<{id:string}>("UPDATE platform.job_attempts SET status='timed_out',finished_at=$3,error_type='worker_timeout',error_message=$4 WHERE job_id=$1::uuid AND attempt_number=$2 AND status='running' RETURNING id::text", [job.id, job.attemptsCount, now.toISOString(), `Finance ${jobTab(job)} export worker lease expired.`])).rows[0];
      if (!stale) throw new Error("Finance export running attempt is missing");
      if (job.attemptsCount >= job.maxAttempts) {
        await client.query("UPDATE platform.jobs SET status='dead_lettered',finished_at=$2,locked_at=NULL,locked_by=NULL,updated_at=$2,job_metadata=job_metadata||jsonb_build_object('outcome','dead_lettered','lastErrorCode','worker_timeout') WHERE id=$1::uuid", [job.id, now.toISOString()]);
        await deadLetter(client, job, stale.id, job.attemptsCount, "worker_timeout", true, now);
        await audit(client, job, job.attemptsCount, "dead_lettered", now, "worker_timeout");
        await client.query("COMMIT"); return "deadLettered";
      }
    }
    const attempt = job.attemptsCount + 1;
    await client.query("UPDATE platform.jobs SET status='running',attempts_count=$2,locked_at=$3,locked_by=$4,updated_at=$3 WHERE id=$1::uuid", [job.id, attempt, now.toISOString(), workerId]);
    const attemptId = (await client.query<{ id: string }>("INSERT INTO platform.job_attempts(job_id,attempt_number,status,worker_id,started_at) VALUES($1::uuid,$2,'running',$3,$4) RETURNING id::text", [job.id, attempt, workerId, now.toISOString()])).rows[0]!.id;
    let artifact: FinanceCsvArtifact, manifestCount=0;
    try {
      const payload = parseFinanceExportJobPayload(job.payload, { organizationId: job.organizationId, propertyId: job.propertyId, currency: job.currency, payloadFingerprint: job.payloadFingerprint, acceptedAt: job.acceptedAt, snapshotAt: job.snapshotAt, expiresAt: job.expiresAt, now });
      if (!uuid(job.actorUserId) || !jobMatchesFormat(job.jobType,payload.snapshot.formatVersion) || job.formatVersion !== payload.snapshot.formatVersion || hash(JSON.stringify(payload.snapshot.manifest)) !== job.manifestDigest) throw new TypeError("Finance export metadata is invalid");
      manifestCount=payload.snapshot.manifest.length;
      const rendered = payload.snapshot.formatVersion===FINANCE_EXPENSE_CSV_VERSION ? await read.exportCsv(job.propertyId,job.currency,payload.snapshot) : payload.snapshot.formatVersion===FINANCE_PROFIT_LOSS_CSV_VERSION ? buildFinanceProfitLossCsvArtifact({propertyId:job.propertyId,response:payload.snapshot.manifest[0].response,query:payload.snapshot.filters,asOf:payload.snapshot.asOf,categoryRows:payload.snapshot.manifest[0].categoryRows}) : await read.exportReady(job.propertyId, job.currency, payload.snapshot);
      if (!rendered || !validArtifact(rendered, job.propertyId, job.currency, payload.snapshot)) throw new TypeError("Finance export evidence is unavailable");
      artifact = rendered;
    } catch (error) {
      const failure = error instanceof ExecutionFailure ? error : error instanceof TypeError || error instanceof FinanceFolioEvidenceError || error instanceof FinanceExpenseEvidenceError ? new ExecutionFailure("invalid_export_evidence", false) : new ExecutionFailure("export_read_failed", true);
      const outcome = await fail(client, job, attemptId, attempt, failure, now, options.random ?? Math.random);
      await client.query("COMMIT"); return outcome;
    }
    const beforeWrite = clock();
    if (beforeWrite.getTime() >= new Date(job.expiresAt).getTime()) { const outcome=await fail(client,job,attemptId,attempt,new ExecutionFailure("export_expired",false),beforeWrite,options.random??Math.random);await client.query("COMMIT");return outcome; }
    await registerArtifactIntent(client, job, writer.bucketName, artifact, attempt, workerId, beforeWrite);
    await client.query("COMMIT");
    let stored: FinanceFolioExportArtifact;
    try { stored=await writer.write({exportId:job.id,body:artifact.body,contentType:artifact.contentType,formatVersion:artifact.formatVersion,expiresAt:job.expiresAt});if(!validStored(stored,writer.bucketName,job.id,artifact.body,artifact.formatVersion))throw new Error("Invalid private artifact receipt"); }
    catch { const failedAt=clock();await client.query("BEGIN");if(!await lockAttempt(client,job,attempt,workerId)){await client.query("COMMIT");return null;}const failure=failedAt.getTime()>=new Date(job.expiresAt).getTime()?new ExecutionFailure("export_expired",false):new ExecutionFailure("artifact_write_failed",true),outcome=await fail(client,job,attemptId,attempt,failure,failedAt,options.random??Math.random);await client.query("COMMIT");return outcome; }
    const completedAt=clock();await client.query("BEGIN");
    if(!await lockAttempt(client,job,attempt,workerId)){await client.query("COMMIT");return null;}
    if(completedAt.getTime()>=new Date(job.expiresAt).getTime()){const outcome=await fail(client,job,attemptId,attempt,new ExecutionFailure("export_expired",false),completedAt,options.random??Math.random);await client.query("COMMIT");return outcome;}
    await activateArtifact(client, job, stored, completedAt);
    const metadata = { mediaId:job.id, checksumSha256:stored.checksumSha256, sizeBytes:stored.sizeBytes, filename: artifact.filename, contentType: artifact.contentType, formatVersion: artifact.formatVersion, rowCount: artifact.rowCount, expiresAt: job.expiresAt };
    await client.query("UPDATE platform.job_attempts SET status='succeeded',finished_at=$4,error_metadata=jsonb_build_object('outcome','succeeded','rowCount',$5::int) WHERE id=$1::uuid AND job_id=$2::uuid AND attempt_number=$3 AND status='running'", [attemptId, job.id, attempt, completedAt.toISOString(), artifact.rowCount]);
    await client.query("UPDATE platform.jobs SET status='succeeded',finished_at=$3,locked_at=NULL,locked_by=NULL,updated_at=$3,job_metadata=(job_metadata-'lastErrorCode')||jsonb_build_object('outcome','succeeded','artifact',$4::jsonb) WHERE id=$1::uuid AND attempts_count=$2 AND status='running'", [job.id, attempt, completedAt.toISOString(), JSON.stringify(metadata)]);
    await audit(client, job, attempt, "succeeded", completedAt, undefined, { rowCount: artifact.rowCount, manifestCount, checksumSha256: stored.checksumSha256 });
    await client.query("COMMIT"); return "succeeded";
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

// prettier-ignore
class ExecutionFailure extends Error { constructor(readonly code:string,readonly retryable:boolean){super(code);} }
// prettier-ignore
async function fail(client:pg.PoolClient,job:Job,attemptId:string,attempt:number,error:ExecutionFailure,now:Date,random:()=>number):Promise<"retryScheduled"|"deadLettered">{const retry=error.retryable&&attempt<job.maxAttempts,retryAt=retry?new Date(now.getTime()+retryDelay(attempt,random)):null,summary=`Finance ${jobTab(job)} export failed (${error.code}).`;await client.query("UPDATE platform.job_attempts SET status='failed',finished_at=$4,error_type=$5,error_message=$6,retry_after=$7,error_metadata=jsonb_build_object('retryable',$8::boolean) WHERE id=$1::uuid AND job_id=$2::uuid AND attempt_number=$3",[attemptId,job.id,attempt,now.toISOString(),error.code,summary,retryAt?.toISOString()??null,error.retryable]);await client.query("UPDATE platform.jobs SET status=$3,run_after=COALESCE($4,run_after),finished_at=CASE WHEN $3='dead_lettered' THEN $5::timestamptz ELSE NULL END,locked_at=NULL,locked_by=NULL,updated_at=$5,job_metadata=job_metadata||jsonb_build_object('outcome',$6::text,'lastErrorCode',$7::text) WHERE id=$1::uuid AND attempts_count=$2 AND status='running'",[job.id,attempt,retry?"pending":"dead_lettered",retryAt?.toISOString()??null,now.toISOString(),retry?"retry_scheduled":"dead_lettered",error.code]);if(!retry)await deadLetter(client,job,attemptId,attempt,error.code,error.retryable,now);await audit(client,job,attempt,retry?"retry_scheduled":"dead_lettered",now,error.code);return retry?"retryScheduled":"deadLettered";}
// prettier-ignore
async function deadLetter(client:pg.PoolClient,job:Job,attemptId:string,attempt:number,code:string,replayEligible:boolean,now:Date){await client.query(`INSERT INTO platform.dead_letter_events(source_kind,job_id,job_attempt_id,tenant_scope,property_id,resource_product,resource_type,resource_id,correlation_id,idempotency_key_hash,reason_code,failure_summary,failure_payload,created_at) VALUES('job',$1::uuid,$2::uuid,'property',$3::uuid,'finance',$4,$5,$6,$7,$8,$9,jsonb_build_object('attemptNumber',$10::int,'affectedOrganizationId',$11::text,'lastAttemptAt',$12::text,'ownerPackage','backend-events','replayEligible',$13::boolean),$12::timestamptz) ON CONFLICT DO NOTHING`,[job.id,attemptId,job.propertyId,job.resourceType,job.resourceId,job.correlationId,job.idempotencyKeyHash,code,`Finance ${jobTab(job)} export failed (${code}).`,attempt,job.organizationId,now.toISOString(),replayEligible]);}
// prettier-ignore
async function audit(client:pg.PoolClient,job:Job,attempt:number,outcome:string,now:Date,code?:string,evidence:Record<string,unknown>={}){const tab=jobTab(job);await client.query(`INSERT INTO platform.product_audit_events(audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,target_resource_product,target_resource_type,target_resource_id,job_id,correlation_id,causation_id,redacted_payload,audit_metadata,retention_class,privacy_scope) VALUES($1,'finance',$2,$3,'property',$4::uuid,'system','finance',$5,$6,$7::uuid,$8,$9,$10::jsonb,jsonb_build_object('queueName',$11::text,'jobType',$12::text,'requestId',$13::text,'organizationId',$14::text,'initiatingActorUserId',$15::text),'financial','confidential') ON CONFLICT(product,audit_key) DO NOTHING`,[`finance.${tab}-export:${job.id}:attempt:${attempt}:${outcome}`,`finance.${tab}_export.${outcome}`,now.toISOString(),job.propertyId,job.resourceType,job.resourceId,job.id,job.correlationId,job.causationId,JSON.stringify({outcome,attemptNumber:attempt,...evidence,...(code?{failureCode:code}:{})}),FINANCE_FOLIO_EXPORT_QUEUE,job.jobType,job.requestId,job.organizationId,job.actorUserId]);}

// prettier-ignore
async function registerArtifactIntent(client:pg.PoolClient,job:Job,bucket:string,artifact:FinanceCsvArtifact,attempt:number,workerId:string,now:Date){const key=storageKey(job.id,artifact.formatVersion),inserted=await client.query(`INSERT INTO platform.media_objects(id,bucket,storage_key,visibility,purpose,owner_organization_id,property_id,resource_product,resource_type,resource_id,lifecycle_status,content_type,original_filename,source_system,source_table,source_row_id,retained_until,created_by_user_id,created_at,updated_at) VALUES($1::uuid,$2,$3,'private','finance.financials_export',$4::uuid,$5::uuid,'finance','financials_export',$1::text,'upload_pending',$6,$7,'platform','platform.jobs',$1::text,$8::timestamptz,$9::uuid,$10,$10) ON CONFLICT(id) DO UPDATE SET updated_at=EXCLUDED.updated_at WHERE platform.media_objects.source_system='platform' AND platform.media_objects.source_table='platform.jobs' AND platform.media_objects.source_row_id=$1::text AND platform.media_objects.purpose='finance.financials_export' AND platform.media_objects.bucket=$2 AND platform.media_objects.storage_key=$3 AND platform.media_objects.retained_until=$8::timestamptz AND platform.media_objects.lifecycle_status='upload_pending' RETURNING id`,[job.id,bucket,key,job.organizationId,job.propertyId,artifact.contentType,artifact.filename,job.expiresAt,job.actorUserId,now.toISOString()]),refreshed=await client.query("UPDATE platform.jobs SET locked_at=$4,updated_at=$4 WHERE id=$1::uuid AND status='running' AND attempts_count=$2 AND locked_by=$3 RETURNING id",[job.id,attempt,workerId,now.toISOString()]);if(!inserted.rowCount||!refreshed.rowCount)throw new Error("Finance export artifact registry conflict");}
// prettier-ignore
async function activateArtifact(client:pg.PoolClient,job:Job,stored:FinanceFolioExportArtifact,now:Date){const updated=await client.query("UPDATE platform.media_objects SET lifecycle_status='active',size_bytes=$2,checksum_sha256=$3,updated_at=$4 WHERE id=$1::uuid AND lifecycle_status='upload_pending' AND bucket=$5 AND storage_key=$6 AND retained_until=$7::timestamptz RETURNING id",[job.id,stored.sizeBytes,stored.checksumSha256,now.toISOString(),stored.bucketName,stored.storageKey,job.expiresAt]);if(!updated.rowCount)throw new Error("Finance export artifact finalization conflict");}
// prettier-ignore
async function lockAttempt(client:pg.PoolClient,job:Job,attempt:number,workerId:string){return Boolean((await client.query("SELECT 1 FROM platform.jobs job JOIN platform.job_attempts attempt ON attempt.job_id=job.id AND attempt.attempt_number=$2 AND attempt.status='running' WHERE job.id=$1::uuid AND job.status='running' AND job.attempts_count=$2 AND job.locked_by=$3 FOR UPDATE OF job",[job.id,attempt,workerId])).rowCount);}
function retryDelay(attempt: number, random: () => number) {
  const jitter = Math.min(1, Math.max(0, random()));
  return Math.min(15 * 60_000, 30_000 * 2 ** (attempt - 1) * (0.5 + jitter));
}
// prettier-ignore
function validArtifact(artifact:FinanceCsvArtifact,propertyId:string,currency:string,snapshot:FinanceFolioExportSnapshot|FinanceExpenseExportSnapshot|FinanceProfitLossExportSnapshot){const common=artifact.propertyId===propertyId&&artifact.currency===currency&&Number.isSafeInteger(artifact.rowCount)&&artifact.rowCount>=0&&artifact.body.length>0;if(snapshot.formatVersion===FINANCE_PROFIT_LOSS_CSV_VERSION)return common&&artifact.formatVersion===FINANCE_PROFIT_LOSS_CSV_VERSION&&artifact.contentType===FINANCE_PROFIT_LOSS_CSV_CONTENT_TYPE&&artifact.filename===`pms-financials-profit-loss-${propertyId}-${snapshot.filters.year}-${snapshot.asOf}.csv`&&artifact.asOf===snapshot.asOf&&artifact.generatedAt===snapshot.snapshotAt;if(snapshot.formatVersion===FINANCE_EXPENSE_CSV_VERSION)return common&&artifact.rowCount===snapshot.manifest.length&&artifact.formatVersion===FINANCE_EXPENSE_CSV_VERSION&&artifact.contentType===FINANCE_EXPENSE_CSV_CONTENT_TYPE&&artifact.filename===`pms-financials-expenses-${propertyId}.csv`&&JSON.stringify(artifact.auditEvidence)===JSON.stringify(snapshot.manifest);return common&&artifact.formatVersion===FINANCE_FOLIO_CSV_VERSION&&artifact.contentType===FINANCE_FOLIO_CSV_CONTENT_TYPE&&artifact.filename===`pms-financials-folios-${propertyId}.csv`&&"auditEvidence" in artifact&&JSON.stringify(artifact.auditEvidence)===JSON.stringify(snapshot.manifest.map(({folioId,revision,sourceDigest})=>({folioId,revision,sourceDigest})));}
// prettier-ignore
function validStored(stored:FinanceFolioExportArtifact,bucketName:string,exportId:string,body:string,formatVersion:string){return stored.bucketName===bucketName&&stored.storageKey===storageKey(exportId,formatVersion)&&stored.sizeBytes===Buffer.byteLength(body,"utf8")&&stored.checksumSha256===hash(body);}
const storageKey = (exportId: string, formatVersion: string) =>
  `private/finance/financials-exports/${exportId}/${formatVersion}.csv`;
const jobMatchesFormat = (jobType: string, formatVersion: string) =>
  jobType === FINANCE_FOLIO_EXPORT_JOB
    ? formatVersion === FINANCE_FOLIO_CSV_VERSION
    : jobType === FINANCE_EXPENSE_EXPORT_JOB
      ? formatVersion === FINANCE_EXPENSE_CSV_VERSION
      : jobType === FINANCE_PROFIT_LOSS_EXPORT_JOB &&
        formatVersion === FINANCE_PROFIT_LOSS_CSV_VERSION;
const jobTab = (job: Pick<Job, "jobType">) =>
  job.jobType === FINANCE_EXPENSE_EXPORT_JOB
    ? "expense"
    : job.jobType === FINANCE_PROFIT_LOSS_EXPORT_JOB
      ? "profit_loss"
      : "folio";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
