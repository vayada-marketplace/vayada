import { beforeEach, expect, it, vi } from "vitest";
import {
  applyApprovedReadiness,
  inspectApprovedReadiness,
  parseApprovedReadinessConfiguration,
  parseApprovedReadinessInspection,
  runApprovedReadinessBackfill,
} from "./hotelSetupApprovedReadinessBackfill.js";
import { APPROVED_HOTEL_SETUP_BACKFILLS } from "../hotelSetupApprovedReadinessBackfill.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  end: vi.fn(),
  authority: vi.fn(),
  metadata: vi.fn(),
  account: vi.fn(),
  read: vi.fn(),
  grant: vi.fn(),
  backfill: vi.fn(),
}));
vi.mock("@aws-sdk/client-sts", () => ({
  GetCallerIdentityCommand: class {},
  STSClient: class {
    config = { credentials: async () => ({ accessKeyId: "fixture", secretAccessKey: "fixture" }) };
    send = mocks.account;
    destroy() {}
  },
}));
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  DescribeSecretCommand: class {
    constructor(public input: unknown) {}
  },
  SecretsManagerClient: class {
    send = mocks.metadata;
    destroy() {}
  },
}));
vi.mock("../hotelSetupOrganizationRoleStaging.js", () => ({
  hotelSetupOrganizationConnection: () => ({
    query: mocks.query,
    connect: mocks.connect,
    end: mocks.end,
    on: vi.fn(),
  }),
  lockHotelSetupOrganizationBootstrapAuthority: mocks.authority,
}));
vi.mock("../hotelSetupNativeSecretReader.js", () => ({
  createHotelSetupNativeSecretReader: () => mocks.read,
}));
vi.mock("../hotelSetupReadinessReaderGrant.js", () => ({
  grantHotelSetupReadinessReaderColumns: mocks.grant,
}));
vi.mock("../hotelSetupApprovedReadinessBackfill.js", async (original) => ({
  ...(await original<object>()),
  backfillApprovedHotelSetupOrganizationReadiness: mocks.backfill,
}));

const databaseEndpoint =
  "postgresql://vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/vayada_target_prod";
const inspection = () => ({
  organizations: APPROVED_HOTEL_SETUP_BACKFILLS.map((binding, index) => ({
    ...binding,
    expectedRoleOid: 100 + index,
    secretVersion: `${index + 1}`.repeat(32),
  })),
  readers: { expectedCreationReaderOid: 102, expectedPropertyReaderOid: 103 },
});
const env = {
  HOTEL_SETUP_AUTOMATIC_ADMIN_DATABASE_URL: `postgresql://vayada_admin:${"x".repeat(36)}@vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com:5432/postgres?sslmode=require`,
  NODE_EXTRA_CA_CERTS: "/runtime/rds-ca.pem",
  HOTEL_SETUP_APPROVED_READINESS_MODE: "inspect",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.connect.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined);
  mocks.account.mockResolvedValue({ Account: "269416271598" });
  mocks.query.mockImplementation(async (sql: string, params?: string[]) => {
    if (sql.includes("hotel_setup_creation_scopes")) {
      const binding = APPROVED_HOTEL_SETUP_BACKFILLS.find((item) => item.login === params?.[0])!;
      return { rows: [{ database_login: binding.login, organization_id: binding.organizationId }] };
    }
    if (sql.includes("pg_authid")) {
      const index = [
        ...APPROVED_HOTEL_SETUP_BACKFILLS.map((item) => item.login),
        "vayada_next_hotel_setup_creation_reader",
        "vayada_next_hotel_setup_reader",
      ].indexOf(params![0]!);
      return { rows: [{ oid: 100 + index }] };
    }
    return { rows: [] };
  });
  mocks.metadata.mockImplementation(async ({ input }: { input: { SecretId: string } }) => ({
    Name: input.SecretId,
    ARN: `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${input.SecretId}-abcdef`,
    VersionIdsToStages: {
      [input.SecretId.endsWith(APPROVED_HOTEL_SETUP_BACKFILLS[0]!.login)
        ? "1".repeat(32)
        : "2".repeat(32)]: ["AWSCURRENT"],
    },
  }));
  mocks.read.mockImplementation(async (name: string) => ({
    username: name.split("/").at(-1),
    password: "y".repeat(36),
  }));
  mocks.grant.mockResolvedValue({ status: "granted" });
  mocks.backfill.mockImplementation(async ({ inspectionReceipt }) => ({
    status: "ready",
    organizationId: inspectionReceipt.organizationId,
    login: inspectionReceipt.login,
    roleOid: inspectionReceipt.expectedRoleOid,
    secretVersion: inspectionReceipt.secretVersion,
  }));
});

it("requires the exact two approved bindings, explicit distinct OIDs and immutable versions", () => {
  expect(parseApprovedReadinessInspection(JSON.stringify(inspection()))).toEqual(inspection());
  const invalid = [
    { ...inspection(), extra: true },
    { ...inspection(), organizations: [] },
    { ...inspection(), organizations: [...inspection().organizations].reverse() },
    { ...inspection(), readers: { ...inspection().readers, expectedCreationReaderOid: 100 } },
    ...["organizationId", "actorUserId", "login", "expectedRoleOid", "secretVersion"].map((key) => {
      const value = inspection();
      (value.organizations[0] as Record<string, unknown>)[key] = "unexpected";
      return value;
    }),
    ...[0, -1, 1.2, 4294967296, "100"].map((oid) => ({
      ...inspection(),
      readers: { ...inspection().readers, expectedCreationReaderOid: oid },
    })),
    {
      ...inspection(),
      organizations: inspection().organizations.map((item) => ({
        ...item,
        password: "unexpected",
      })),
    },
  ];
  for (const value of invalid)
    expect(() => parseApprovedReadinessInspection(JSON.stringify(value))).toThrow();
});

it("requires explicit inspect/apply, the reviewed admin endpoint and frozen apply receipt", () => {
  expect(parseApprovedReadinessConfiguration(env).mode).toBe("inspect");
  expect(
    parseApprovedReadinessConfiguration({
      ...env,
      HOTEL_SETUP_APPROVED_READINESS_MODE: "apply",
      HOTEL_SETUP_APPROVED_READINESS_INSPECTION: JSON.stringify(inspection()),
    }).inspection,
  ).toEqual(inspection());
  for (const override of [
    { HOTEL_SETUP_APPROVED_READINESS_MODE: "apply" },
    { HOTEL_SETUP_APPROVED_READINESS_MODE: "other" },
    { HOTEL_SETUP_APPROVED_READINESS_INSPECTION: JSON.stringify(inspection()) },
    { NODE_EXTRA_CA_CERTS: "/unexpected.pem" },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    {
      HOTEL_SETUP_AUTOMATIC_ADMIN_DATABASE_URL:
        env.HOTEL_SETUP_AUTOMATIC_ADMIN_DATABASE_URL.replace("/postgres?", "/other?"),
    },
  ])
    expect(() => parseApprovedReadinessConfiguration({ ...env, ...override })).toThrow();
});

it("inspects only approved bindings and metadata after releasing DB locks; performs no grants/value reads", async () => {
  const config = parseApprovedReadinessConfiguration(env);
  expect(await inspectApprovedReadiness(config)).toEqual(inspection());
  expect(mocks.authority).toHaveBeenCalledTimes(2);
  expect(mocks.end.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.metadata.mock.invocationCallOrder[0]!,
  );
  expect(
    mocks.query.mock.calls.every(
      ([sql]) => !/INSERT|UPDATE\s+platform|GRANT|ALTER|CREATE/.test(sql),
    ),
  ).toBe(true);
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.grant).not.toHaveBeenCalled();
  expect(mocks.backfill).not.toHaveBeenCalled();
});

it("rejects ambiguous or wrong-account metadata and assignment changes", async () => {
  const config = parseApprovedReadinessConfiguration(env);
  mocks.metadata.mockResolvedValueOnce({ Name: "other" });
  await expect(inspectApprovedReadiness(config)).rejects.toThrow();
  mocks.account.mockResolvedValueOnce({ Account: "other" });
  await expect(inspectApprovedReadiness(config)).rejects.toThrow();
  mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
  await expect(inspectApprovedReadiness(config)).rejects.toThrow();
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.grant).not.toHaveBeenCalled();
});

it("reads both exact versions before grants and supplies each frozen identity to actual proof helpers", async () => {
  const config = { ...parseApprovedReadinessConfiguration(env), inspection: inspection() };
  const secondary = vi.fn();
  const result = await applyApprovedReadiness(config, secondary);
  expect(result.status).toBe("PASS");
  expect(result.organizations).toHaveLength(2);
  expect(mocks.read.mock.calls).toEqual(
    inspection().organizations.map((item) => [
      `hotel-setup-command/prod/organization/${item.login}`,
      item.secretVersion,
    ]),
  );
  expect(mocks.read.mock.invocationCallOrder[1]).toBeLessThan(
    mocks.grant.mock.invocationCallOrder[0]!,
  );
  for (const [index, call] of mocks.backfill.mock.calls.entries()) {
    expect(call[0].inspectionReceipt).toEqual(inspection().organizations[index]);
    expect(call[0].proveSecondary).toBe(secondary);
    expect(new URL(call[0].nativeDatabaseUrl).search).toBe("?sslmode=verify-full");
  }
  expect(JSON.stringify(result)).not.toContain("y".repeat(36));
});

it("rejects malformed pinned payloads before any grant", async () => {
  const config = { ...parseApprovedReadinessConfiguration(env), inspection: inspection() };
  mocks.read
    .mockResolvedValueOnce({
      username: inspection().organizations[0]!.login,
      password: "y".repeat(36),
    })
    .mockResolvedValueOnce({
      username: inspection().organizations[1]!.login,
      password: "y".repeat(36),
      extra: true,
    });
  await expect(applyApprovedReadiness(config, vi.fn())).rejects.toThrow();
  expect(mocks.grant).not.toHaveBeenCalled();
  expect(mocks.backfill).not.toHaveBeenCalled();
});

it("denies alternate executable roots before admin/AWS access and emits a sanitized failure", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(await runApprovedReadinessBackfill(env)).toBe(1);
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.account).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ status: "FAIL", code: "hotel_setup_approved_readiness_inspection_required" }),
  );
  stderr.mockRestore();
});
