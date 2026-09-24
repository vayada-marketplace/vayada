import { pathToFileURL } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { FINANCE_DASHBOARD_CSV_VERSION } from "@vayada/domain-finance";
import pg from "pg";

import {
  FINANCE_DASHBOARD_EXPORT_JOB,
  FINANCE_FOLIO_EXPORT_QUEUE,
} from "../domains/financeFolioExportRepository.js";
import { createS3FinanceFolioExportArtifactWriter } from "../platform/financeFolioExportArtifacts.js";
import {
  assertFinanceExportWorkerBoundary,
  FINANCE_EXPORT_WORKER_ROLE,
} from "./financeExportWorkerBoundary.js";
import { runFinanceFolioExportJobs } from "./financeFolioExport.js";
import { exportDeadlineClient } from "./financeExportDeadline.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const required = (key: string) => {
  const value = process.env[key];
  if (!value || value !== value.trim()) throw new Error("one_shot_config_invalid");
  return value;
};
const instant = (value: string) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    throw new Error("one_shot_config_invalid");
  return date;
};

export async function runFinanceDashboardExportOnce() {
  const exportId = required("FINANCE_EXPORT_WORKER_EXPORT_ID");
  const propertyId = required("FINANCE_EXPORT_WORKER_PROPERTY_ID");
  const dispatchedAt = instant(required("FINANCE_EXPORT_DISPATCHED_AT"));
  let deadline = new Date(dispatchedAt.getTime() + 900_000);
  if (Date.now() < dispatchedAt.getTime() || Date.now() >= deadline.getTime())
    throw new Error("one_shot_dispatch_window_invalid");
  const bucket = required("PLATFORM_MEDIA_BUCKET");
  const roleArn = required("FINANCE_EXPORT_WRITER_ROLE_ARN");
  const databaseUrl = new URL(required("FINANCE_EXPORT_WORKER_DATABASE_URL"));
  if (
    !uuid.test(exportId) ||
    !uuid.test(propertyId) ||
    !/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9_+=,.@\/-]+$/.test(roleArn) ||
    !/^[a-z0-9.-]+$/.test(bucket) ||
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    decodeURIComponent(databaseUrl.username) !== FINANCE_EXPORT_WORKER_ROLE ||
    !databaseUrl.password ||
    databaseUrl.search !== "?sslmode=require" ||
    databaseUrl.hash
  )
    throw new Error("one_shot_config_invalid");
  const pool = new pg.Pool({
    connectionString: databaseUrl.toString(),
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    query_timeout: Math.min(5_000, deadline.getTime() - Date.now()),
  });
  const sts = new STSClient({
    maxAttempts: 1,
    requestHandler: NodeHttpHandler.create({
      connectionTimeout: 5_000,
      requestTimeout: 10_000,
      throwOnRequestTimeout: true,
    }),
  });
  let s3: S3Client | undefined;
  try {
    const rawClient = await pool.connect();
    const client = exportDeadlineClient(rawClient, () => deadline.getTime());
    try {
      const login = (await client.query("SELECT current_user,session_user")).rows[0];
      if (
        login.current_user !== FINANCE_EXPORT_WORKER_ROLE ||
        login.session_user !== FINANCE_EXPORT_WORKER_ROLE
      )
        throw new Error("one_shot_role_mismatch");
      await assertFinanceExportWorkerBoundary(client, { propertyId, exportId });
      const row = (
        await client.query<{
          acceptedAt: string;
          expiresAt: string;
          status: string;
          attemptsCount: number;
          jobType: string;
        }>(
          `SELECT job_metadata->>'acceptedAt' AS "acceptedAt",job_metadata->>'expiresAt' AS "expiresAt",status,attempts_count::int AS "attemptsCount",job_type AS "jobType" FROM platform.jobs WHERE id=$1::uuid AND property_id=$2::uuid AND queue_name=$3`,
          [exportId, propertyId, FINANCE_FOLIO_EXPORT_QUEUE],
        )
      ).rows[0];
      if (
        !row ||
        row.jobType !== FINANCE_DASHBOARD_EXPORT_JOB ||
        row.status !== "pending" ||
        row.attemptsCount !== 0
      )
        throw new Error("one_shot_job_not_fresh");
      const acceptedAt = instant(row.acceptedAt),
        expiresAt = instant(row.expiresAt);
      if (acceptedAt.getTime() < dispatchedAt.getTime())
        throw new Error("one_shot_clock_ambiguous");
      deadline = new Date(
        Math.min(
          dispatchedAt.getTime() + 900_000,
          acceptedAt.getTime() + 900_000,
          expiresAt.getTime(),
        ),
      );
      if (Date.now() >= deadline.getTime()) throw new Error("one_shot_deadline_passed");
    } finally {
      client.release(true);
    }
    const key = `private/finance/financials-exports/${exportId}/${FINANCE_DASHBOARD_CSV_VERSION}.csv`;
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: "s3:PutObject",
          Resource: `arn:aws:s3:::${bucket}/${key}`,
          Condition: { DateLessThan: { "aws:CurrentTime": deadline.toISOString() } },
        },
      ],
    });
    const assumed = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `finance-export-${exportId.replaceAll("-", "")}`,
        DurationSeconds: 900,
        Policy: policy,
      }),
      { abortSignal: AbortSignal.timeout(Math.max(1, deadline.getTime() - Date.now())) },
    );
    const credentials = assumed.Credentials;
    if (
      !credentials?.AccessKeyId ||
      !credentials.SecretAccessKey ||
      !credentials.SessionToken ||
      Date.now() >= deadline.getTime()
    )
      throw new Error("one_shot_writer_unavailable");
    s3 = new S3Client({
      maxAttempts: 1,
      credentials: {
        accessKeyId: credentials.AccessKeyId,
        secretAccessKey: credentials.SecretAccessKey,
        sessionToken: credentials.SessionToken,
      },
      requestChecksumCalculation: "WHEN_REQUIRED",
      requestHandler: NodeHttpHandler.create({
        connectionTimeout: 5_000,
        requestTimeout: 30_000,
        socketTimeout: 30_000,
        throwOnRequestTimeout: true,
      }),
    });
    const writer = createS3FinanceFolioExportArtifactWriter({ bucketName: bucket, s3Client: s3 });
    const deniedRead = async (): Promise<never> => {
      throw new Error("one_shot_non_dashboard_read_denied");
    };
    const result = await runFinanceFolioExportJobs(
      pool,
      { exportReady: deniedRead, exportCsv: deniedRead },
      writer,
      { exportId, oneShot: { propertyId, dispatchedAt }, limit: 1 },
    );
    if (result.succeeded !== 1 || result.deadLettered || result.retryScheduled)
      throw new Error(result.deadLettered ? "one_shot_dead_lettered" : "one_shot_not_succeeded");
    if (Date.now() >= deadline.getTime()) throw new Error("one_shot_deadline_passed");
    process.stdout.write(JSON.stringify({ outcome: "succeeded", exportId }) + "\n");
  } finally {
    s3?.destroy();
    sts.destroy();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runFinanceDashboardExportOnce().catch((error: unknown) => {
    process.stderr.write(
      JSON.stringify({
        outcome: "failed",
        code:
          error instanceof Error && /^one_shot_[a-z_]+$/.test(error.message)
            ? error.message
            : "one_shot_failed",
      }) + "\n",
    );
    process.exitCode = 1;
  });
