import { EventEmitter } from "node:events";
import { STSClient } from "@aws-sdk/client-sts";
import {
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { afterEach, expect, it, vi } from "vitest";
import {
  APPROVED_HOTEL_SETUP_BACKFILLS,
  backfillApprovedHotelSetupOrganizationReadiness,
} from "./hotelSetupApprovedReadinessBackfill.js";
import {
  hotelSetupOrganizationConnection,
  lockHotelSetupOrganizationBootstrapAuthority,
} from "./hotelSetupOrganizationRoleStaging.js";
import { checkHotelSetupCreationCredential } from "./cli/hotelSetupCreationPreflight.js";

vi.mock("./hotelSetupOrganizationRoleStaging.js", async (load) => ({
  ...(await load<typeof import("./hotelSetupOrganizationRoleStaging.js")>()),
  hotelSetupOrganizationConnection: vi.fn(),
  lockHotelSetupOrganizationBootstrapAuthority: vi.fn(),
}));
vi.mock("./cli/hotelSetupCreationPreflight.js", () => ({
  checkHotelSetupCreationCredential: vi.fn(),
}));
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  "success",
  "lockBusy",
  "animal",
  "replay",
  "wrongOid",
  "nativeOid",
  "partialReady",
  "proof",
  "grantNotice",
  "authority",
  "retarget",
  "assignmentDrift",
  "passwordDrift",
  "nativeCurrentUser",
  "nativeConnect",
  "nativeEffectiveOid",
  "inspectionPassword",
  "currentVersion",
  "inspectionVersion",
  "wrongAccount",
  "secretVersion",
  "secretArn",
  "secretFields",
  "secretPassword",
  "binary",
  "commitLost",
  "commitRejected",
  "inspectionRetarget",
])("protects the existing inspected identity on %s", async (mode) => {
  const binding = APPROVED_HOTEL_SETUP_BACKFILLS[mode === "animal" ? 1 : 0]!;
  const receipt = { ...binding, expectedRoleOid: 42, secretVersion: "1".repeat(32) };
  const password = "p".repeat(36);
  const name = `hotel-setup-command/prod/organization/${binding.login}`;
  const input = {
    adminDatabaseUrl: `postgresql://admin:${"a".repeat(36)}@db.internal/fixture?sslmode=verify-full`,
    nativeDatabaseUrl: `postgresql://${binding.login}:${password}@db.internal/fixture?sslmode=verify-full`,
    databaseEndpoint: "postgresql://db.internal/fixture",
    inspectionReceipt: receipt,
    proveSecondary: vi.fn(async () => {
      expect(clients[0]!.transaction).toBe(false);
      if (mode === "proof") throw new Error("private-proof-diagnostic");
    }),
  };
  let metadataReads = 0,
    nativeAuthentications = 0,
    identityReads = 0,
    assignmentReads = 0,
    authorityReads = 0;
  const pending = {
    database_login: binding.login,
    organization_id: binding.organizationId,
    credential_role_oid: null as number | null,
    credential_secret_version: null as string | null,
    ready_at: null as string | null,
    assignment_xid: "10",
  };
  let state =
    mode === "replay"
      ? {
          ...pending,
          credential_role_oid: 42,
          credential_secret_version: receipt.secretVersion,
          ready_at: "initial-ready",
        }
      : { ...pending };
  const queries: string[] = [];
  class Client extends EventEmitter {
    transaction = false;
    write: typeof state | undefined;
    constructor(readonly native = false) {
      super();
    }
    connect = vi.fn(async () => {
      if (this.native && mode === "nativeConnect")
        throw new Error("private-authentication-diagnostic");
      if (
        this.native &&
        ++nativeAuthentications > (mode === "inspectionPassword" ? 5 : 3) &&
        ["passwordDrift", "inspectionPassword"].includes(mode)
      )
        throw new Error("private-authentication-diagnostic");
    });
    end = vi.fn(async () => undefined);
    escapeIdentifier = (identifier: string) => `"${identifier}"`;
    async query(sql: string, params?: unknown[]) {
      queries.push(sql);
      if (sql.includes("pg_try_advisory_lock(8734516)"))
        return { rows: [{ held: mode !== "lockBusy" }] };
      if (sql.startsWith("BEGIN")) this.transaction = true;
      if (sql === "ROLLBACK") {
        this.transaction = false;
        this.write = undefined;
      }
      if (sql === "COMMIT") {
        if (this.write) {
          if (mode === "commitRejected") throw new Error("private-commit-diagnostic");
          state = this.write;
          this.write = undefined;
          this.transaction = false;
          if (
            [
              "commitLost",
              "inspectionRetarget",
              "inspectionPassword",
              "inspectionVersion",
            ].includes(mode)
          )
            throw new Error("private-commit-diagnostic");
        }
        this.transaction = false;
      }
      if (sql.startsWith("GRANT") && mode === "grantNotice") this.emit("notice", { code: "01007" });
      if (sql.includes("SELECT session_user"))
        return {
          rows: [
            {
              session_login: binding.login,
              effective_login: mode === "nativeCurrentUser" ? "other" : binding.login,
              role_oid: mode === "nativeOid" ? 43 : 42,
              effective_oid: mode === "nativeEffectiveOid" ? 43 : 42,
            },
          ],
        };
      if (sql.includes("SELECT r.oid FROM pg_catalog.pg_roles")) {
        identityReads++;
        expect(params).toEqual([42, binding.login]);
        expect(sql).not.toContain("FROM pg_catalog.pg_authid");
        return { rows: mode === "wrongOid" ? [] : [{ oid: 42 }] };
      }
      if (sql.includes("SELECT database_login")) {
        assignmentReads++;
        return {
          rows: [
            {
              ...state,
              ...(mode === "partialReady" ? { credential_role_oid: 42 } : {}),
              ...(mode === "retarget" || (mode === "inspectionRetarget" && assignmentReads > 2)
                ? { organization_id: binding.actorUserId }
                : {}),
              ...(mode === "assignmentDrift" && assignmentReads > 1
                ? { assignment_xid: "19" }
                : {}),
            },
          ],
        };
      }
      if (sql.startsWith("UPDATE platform")) {
        this.write = {
          ...state,
          credential_role_oid: 42,
          credential_secret_version: receipt.secretVersion,
          ready_at: "ready",
          assignment_xid: "20",
        };
        return { rowCount: 1, rows: [{ ready_xid: "20" }] };
      }
      return { rows: [] };
    }
  }
  const clients: Client[] = [];
  vi.mocked(hotelSetupOrganizationConnection).mockImplementation((url) => {
    const client = new Client(new URL(url).username === binding.login);
    clients.push(client);
    return client as never;
  });
  vi.mocked(lockHotelSetupOrganizationBootstrapAuthority).mockImplementation(async () => {
    if (++authorityReads > 1 && mode === "authority") throw new Error("revoked actor");
  });
  vi.mocked(checkHotelSetupCreationCredential).mockImplementation(async () => {
    expect(clients[0]!.transaction).toBe(false);
  });
  vi.stubEnv("AWS_ACCESS_KEY_ID", "synthetic-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-secret");
  vi.stubEnv("AWS_PROFILE", undefined);
  vi.stubEnv("AWS_ENDPOINT_URL", "https://wrong.example");
  vi.spyOn(STSClient.prototype, "send").mockImplementation(async function (this: STSClient) {
    expect(clients[0]!.transaction).toBe(false);
    expect((await this.config.endpoint!()).hostname).toBe("sts.eu-west-1.amazonaws.com");
    return { Account: mode === "wrongAccount" ? "000000000000" : "269416271598" };
  } as never);
  const send = vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation(async function (
    this: SecretsManagerClient,
    command: unknown,
  ) {
    expect(clients[0]!.transaction).toBe(false);
    expect(await this.config.region()).toBe("eu-west-1");
    expect((await this.config.endpoint!()).hostname).toBe("secretsmanager.eu-west-1.amazonaws.com");
    if (command instanceof DescribeSecretCommand) {
      metadataReads++;
      expect(command.input).toEqual({ SecretId: name });
      return {
        Name: name,
        ARN: `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${name}-123abc`,
        VersionIdsToStages: {
          [(mode === "currentVersion" && metadataReads > 1) ||
          (mode === "inspectionVersion" && metadataReads > 2)
            ? "2".repeat(32)
            : receipt.secretVersion]: ["AWSCURRENT"],
        },
      };
    }
    expect(command).toBeInstanceOf(GetSecretValueCommand);
    expect((command as GetSecretValueCommand).input).toEqual({
      SecretId: name,
      VersionId: receipt.secretVersion,
    });
    return {
      Name: name,
      VersionId: mode === "secretVersion" ? "2".repeat(32) : receipt.secretVersion,
      ARN: `arn:aws:secretsmanager:eu-west-1:${mode === "secretArn" ? "000000000000" : "269416271598"}:secret:${name}-123abc`,
      SecretString: JSON.stringify({
        username: binding.login,
        password: mode === "secretPassword" ? "different" : password,
        ...(mode === "secretFields" ? { other: "unexpected" } : {}),
      }),
      ...(mode === "binary" ? { SecretBinary: Buffer.from("unexpected") } : {}),
    };
  } as never);
  const run = backfillApprovedHotelSetupOrganizationReadiness(input);
  if (["success", "animal", "replay", "commitLost"].includes(mode))
    await expect(run).resolves.toEqual({
      status:
        mode === "replay"
          ? "already_ready"
          : mode === "commitLost"
            ? "ready_commit_inspected"
            : "ready",
      organizationId: binding.organizationId,
      login: binding.login,
      roleOid: 42,
      secretVersion: receipt.secretVersion,
    });
  else
    await expect(run).rejects.toThrow(
      "Approved hotel setup readiness backfill requires recovery inspection",
    );
  expect(state.ready_at !== null).toBe(
    [
      "success",
      "animal",
      "replay",
      "commitLost",
      "inspectionRetarget",
      "inspectionPassword",
      "inspectionVersion",
    ].includes(mode),
  );
  expect(queries.filter((sql) => sql.startsWith("GRANT"))).toHaveLength(
    mode === "replay" ||
      [
        "retarget",
        "wrongOid",
        "partialReady",
        "lockBusy",
        "nativeOid",
        "nativeCurrentUser",
        "nativeConnect",
        "nativeEffectiveOid",
      ].includes(mode)
      ? 0
      : 1,
  );
  expect(queries.some((sql) => /CREATE ROLE|ALTER ROLE|DROP|DELETE|REVOKE/.test(sql))).toBe(false);
  expect(queries.some((sql) => sql.startsWith("UPDATE platform"))).toBe(
    [
      "success",
      "animal",
      "commitLost",
      "commitRejected",
      "inspectionRetarget",
      "inspectionPassword",
      "inspectionVersion",
    ].includes(mode),
  );
  if (
    [
      "retarget",
      "wrongOid",
      "partialReady",
      "nativeOid",
      "grantNotice",
      "proof",
      "wrongAccount",
    ].includes(mode)
  )
    expect(send).not.toHaveBeenCalled();
  expect(clients.every((client) => client.end.mock.calls.length === 1)).toBe(true);
});

it.each([
  { expectedRoleOid: undefined },
  { expectedRoleOid: 0 },
  { expectedRoleOid: 4294967296 },
  { secretVersion: undefined },
  { secretVersion: "AWSCURRENT" },
  { actorUserId: "wrong" },
  { login: "vayada_next_hotel_setup_org_other" },
  { organizationId: "other" },
])("does not derive or adopt missing or unapproved inspection fields %j", async (override) => {
  const receipt = {
    ...APPROVED_HOTEL_SETUP_BACKFILLS[0],
    expectedRoleOid: 42,
    secretVersion: "1".repeat(32),
    ...override,
  };
  await expect(
    backfillApprovedHotelSetupOrganizationReadiness({
      inspectionReceipt: receipt as never,
      adminDatabaseUrl: "unused",
      nativeDatabaseUrl: "unused",
      databaseEndpoint: "unused",
      proveSecondary: vi.fn(),
    }),
  ).rejects.toThrow("requires recovery inspection");
  expect(hotelSetupOrganizationConnection).not.toHaveBeenCalled();
});
