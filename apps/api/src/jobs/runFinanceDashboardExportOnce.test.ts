import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FINANCE_DASHBOARD_CSV_VERSION } from "@vayada/domain-finance";
import { FINANCE_DASHBOARD_EXPORT_JOB } from "../domains/financeFolioExportRepository.js";

const fake = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  end: vi.fn(),
  assume: vi.fn(),
  run: vi.fn(),
  s3: vi.fn(),
}));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      connect = async () => ({ query: fake.query, release: fake.release });
      end = fake.end;
    },
  },
}));
vi.mock("@aws-sdk/client-sts", async (original) => ({
  ...(await original<object>()),
  STSClient: class {
    send = fake.assume;
    destroy() {}
  },
}));
vi.mock("@aws-sdk/client-s3", async (original) => ({
  ...(await original<object>()),
  S3Client: class {
    constructor(config: unknown) {
      fake.s3(config);
    }
    destroy() {}
  },
}));
vi.mock("./financeExportWorkerBoundary.js", () => ({
  FINANCE_EXPORT_WORKER_ROLE: "vayada_next_finance_export_worker",
  assertFinanceExportWorkerBoundary: vi.fn(),
}));
vi.mock("./financeFolioExport.js", () => ({ runFinanceFolioExportJobs: fake.run }));
import { runFinanceDashboardExportOnce } from "./runFinanceDashboardExportOnce.js";

const id = "11340000-0000-4000-8000-000000000021",
  now = Date.parse("2026-09-24T15:00:01.000Z");
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  for (const [key, value] of Object.entries({
    FINANCE_EXPORT_WORKER_DATABASE_URL:
      "postgresql://vayada_next_finance_export_worker:test-only@localhost/test?sslmode=require",
    FINANCE_EXPORT_WORKER_PROPERTY_ID: "11340000-0000-4000-8000-000000000020",
    FINANCE_EXPORT_WORKER_EXPORT_ID: id,
    FINANCE_EXPORT_DISPATCHED_AT: "2026-09-24T15:00:00.000Z",
    PLATFORM_MEDIA_BUCKET: "test-private",
    FINANCE_EXPORT_WRITER_ROLE_ARN: "arn:aws:iam::269416271598:role/test-writer",
  }))
    vi.stubEnv(key, value);
  fake.query.mockImplementation(async (input: string | { text: string }) => {
    const text = typeof input === "string" ? input : input.text;
    return {
      rows: text.includes("current_user")
        ? [
            {
              current_user: "vayada_next_finance_export_worker",
              session_user: "vayada_next_finance_export_worker",
            },
          ]
        : text.includes("job_metadata")
          ? [
              {
                acceptedAt: "2026-09-24T15:00:00.100Z",
                expiresAt: "2026-09-25T15:00:00.100Z",
                status: "pending",
                attemptsCount: 0,
                jobType: FINANCE_DASHBOARD_EXPORT_JOB,
              },
            ]
          : [],
    };
  });
  fake.assume.mockResolvedValue({
    Credentials: {
      AccessKeyId: "test-key",
      SecretAccessKey: "test-secret",
      SessionToken: "test-token",
    },
  });
  fake.run.mockResolvedValue({ succeeded: 1, retryScheduled: 0, deadLettered: 0 });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("uses only an exact-key deadline-limited writer session and one invocation", async () => {
  await runFinanceDashboardExportOnce();
  const [command, options] = fake.assume.mock.calls[0]!;
  expect(JSON.parse(command.input.Policy)).toEqual({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "s3:PutObject",
        Resource: `arn:aws:s3:::test-private/private/finance/financials-exports/${id}/${FINANCE_DASHBOARD_CSV_VERSION}.csv`,
        Condition: { DateLessThan: { "aws:CurrentTime": "2026-09-24T15:15:00.000Z" } },
      },
    ],
  });
  expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  expect(fake.run).toHaveBeenCalledTimes(1);
  expect(fake.run.mock.calls[0]![3]).toMatchObject({ exportId: id, limit: 1 });
  expect(process.stdout.write).toHaveBeenCalledWith(
    JSON.stringify({ outcome: "succeeded", exportId: id }) + "\n",
  );
  expect(fake.release).toHaveBeenCalledWith(true);
});

it("rejects future or expired dispatch before requesting writer credentials", async () => {
  for (const offset of [-2_000, 900_000]) {
    vi.setSystemTime(now + offset);
    await expect(runFinanceDashboardExportOnce()).rejects.toThrow(
      "one_shot_dispatch_window_invalid",
    );
  }
  expect(fake.assume).not.toHaveBeenCalled();
});

it("does not start the worker when STS completes after the deadline", async () => {
  fake.assume.mockImplementationOnce(async () => {
    vi.setSystemTime(now + 900_000);
    return {
      Credentials: {
        AccessKeyId: "test-key",
        SecretAccessKey: "test-secret",
        SessionToken: "test-token",
      },
    };
  });
  await expect(runFinanceDashboardExportOnce()).rejects.toThrow("one_shot_writer_unavailable");
  expect(fake.run).not.toHaveBeenCalled();
  expect(fake.end).toHaveBeenCalled();
});
