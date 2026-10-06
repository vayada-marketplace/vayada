import { STSClient } from "@aws-sdk/client-sts";
import { createHash } from "node:crypto";
import { expect, it, vi, afterEach } from "vitest";
import pg from "pg";
import { EventEmitter } from "node:events";
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { publishHotelSetupPropertySecret } from "./hotelSetupPropertySecretPublication.js";
import { lockHotelSetupPropertyBootstrapAuthority } from "./hotelSetupPropertyRoleStaging.js";
vi.mock("./hotelSetupPropertyRoleStaging.js", () => ({
  lockHotelSetupPropertyBootstrapAuthority: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(
  [
    "success",
    "existing",
    "unknown",
    "version",
    "readback",
    "retarget",
    "verifier",
    "lateDrift",
    "wrongAccount",
    "ready",
    "revoked",
    "readinessCommit",
    "lateRetarget",
    "lateReady",
    "actorDrift",
    "xidDrift",
    "passwordDrift",
    "sessionLogin",
    "effectiveLogin",
    "sessionOid",
    "effectiveOid",
  ].flatMap((mode) =>
    (["launch_settings", "property_logo"] as const)
      .filter(
        (operation) =>
          ![
            "actorDrift",
            "xidDrift",
            "passwordDrift",
            "sessionLogin",
            "effectiveLogin",
            "sessionOid",
            "effectiveOid",
          ].includes(mode) || operation === "property_logo",
      )
      .map((operation) => [operation, mode] as const),
  ),
)("pins %s credential publication on %s", async (operation, mode) => {
  vi.stubEnv("AWS_ACCESS_KEY_ID", "synthetic-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-secret");
  vi.stubEnv("AWS_PROFILE", undefined);
  vi.stubEnv("AWS_REGION", "us-east-1");
  vi.stubEnv("AWS_ENDPOINT_URL", "https://wrong.example");
  vi.spyOn(STSClient.prototype, "send").mockImplementation(async function (this: STSClient) {
    expect(transaction).toBe(false);
    expect(await this.config.region()).toBe("eu-west-1");
    expect((await this.config.endpoint!()).hostname).toBe("sts.eu-west-1.amazonaws.com");
    return { Account: mode === "wrongAccount" ? "000000000000" : "269416271598" };
  } as never);
  const propertyId = "10000000-0000-4000-8000-000000000001";
  const login = `vayada_next_hotel_setup_${operation === "property_logo" ? "logo" : "property"}_${createHash("sha256").update(`${propertyId}:${operation}`).digest("hex").slice(0, 16)}_123456789abc`;
  const staged = {
    login,
    roleOid: 42,
    propertyId,
    operation,
    organizationId: "10000000-0000-4000-8000-000000000002",
    actorUserId: "10000000-0000-4000-8000-000000000003",
  };
  let identityReads = 0;
  let connections = 0,
    closed = 0;
  class NativeClient extends EventEmitter {
    async connect() {
      connections++;
      if (mode === "passwordDrift" && connections === 2) throw new Error("authentication failed");
    }
    async end() {
      closed++;
    }
    async query() {
      return {
        rows: [
          {
            session_login: mode === "sessionLogin" ? "other" : login,
            effective_login: mode === "effectiveLogin" ? "other" : login,
            role_oid: mode === "sessionOid" ? 43 : 42,
            effective_oid: mode === "effectiveOid" ? 43 : 42,
          },
        ],
      };
    }
  }
  vi.spyOn(pg, "Client").mockImplementation(function (config: pg.ClientConfig) {
    expect(config).toMatchObject({
      user: login,
      password: "b".repeat(36),
      ssl: { rejectUnauthorized: true },
    });
    return new NativeClient();
  } as unknown as typeof pg.Client);
  let assignmentReads = 0,
    commits = 0,
    transaction = false;
  vi.mocked(lockHotelSetupPropertyBootstrapAuthority).mockImplementation(async () => {
    if (mode === "revoked" && identityReads === 1) throw new Error("revoked intent");
  });
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === "BEGIN") transaction = true;
    if (sql === "COMMIT") {
      transaction = false;
      if (++commits === 2 && mode === "readinessCommit") throw new Error("lost acknowledgement");
    }
    if (sql.startsWith("UPDATE platform.hotel_setup_property_scopes")) {
      expect(params).toEqual([
        login,
        42,
        versionId,
        propertyId,
        staged.organizationId,
        operation,
        operation === "property_logo" ? staged.actorUserId : null,
        operation === "property_logo" ? "123" : null,
      ]);
      expect(identityReads).toBe(2);
      expect(send).toHaveBeenCalledTimes(3);
      return { rows: [{ database_login: login }] };
    }
    if (sql.startsWith("SELECT oid")) {
      expect(params).toEqual([
        42,
        login,
        operation === "property_logo" ? null : "private-verifier",
        operation === "property_logo"
          ? "vayada_next_hotel_setup_logo_scope"
          : "vayada_next_hotel_setup_property_scope",
      ]);
      expect(sql.includes("FROM pg_catalog.pg_roles")).toBe(operation === "property_logo");
      identityReads++;
      return {
        rows:
          mode === "verifier" || (mode === "lateDrift" && identityReads === 2) ? [] : [{ oid: 42 }],
      };
    }
    if (sql.includes("FROM platform.hotel_setup_property_scopes")) assignmentReads++;
    const ready = mode === "ready" || (mode === "lateReady" && assignmentReads === 2);
    return {
      rows: [
        {
          property_id:
            mode === "retarget" || (mode === "lateRetarget" && assignmentReads === 2)
              ? staged.organizationId
              : propertyId,
          organization_id: staged.organizationId,
          operation_class: operation,
          actor_user_id: mode === "actorDrift" ? propertyId : staged.actorUserId,
          active: true,
          credential_role_oid: ready ? 42 : null,
          credential_secret_version: ready ? "x".repeat(32) : null,
          credential_ready_at: ready ? new Date() : null,
          assignment_xid: mode === "xidDrift" && assignmentReads === 2 ? "124" : "123",
        },
      ],
    };
  });
  let versionId = "",
    payload = "";
  const name = `hotel-setup-command/prod/property/${login}`;
  const arn = `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${name}-123abc`;
  const send = vi.fn(async function (this: SecretsManagerClient, command: unknown) {
    expect(transaction).toBe(false);
    expect(await this.config.region()).toBe("eu-west-1");
    expect((await this.config.endpoint!()).hostname).toBe("secretsmanager.eu-west-1.amazonaws.com");
    if (command instanceof DescribeSecretCommand) {
      expect(command.input.SecretId).toBe(name);
      if (mode === "existing") return { ARN: arn };
      const error = new Error("private-diagnostic");
      error.name = mode === "unknown" ? "AccessDeniedException" : "ResourceNotFoundException";
      throw error;
    }
    if (command instanceof CreateSecretCommand) {
      versionId = command.input.ClientRequestToken!;
      payload = command.input.SecretString!;
      expect(JSON.parse(payload)).toEqual({ username: login, password: "b".repeat(36) });
      return { ARN: arn, Name: name, VersionId: mode === "version" ? "other" : versionId };
    }
    expect(command).toBeInstanceOf(GetSecretValueCommand);
    expect((command as GetSecretValueCommand).input).toEqual({
      SecretId: arn,
      VersionId: versionId,
    });
    return {
      ARN: arn,
      Name: name,
      VersionId: versionId,
      SecretString: mode === "readback" ? "other" : payload,
    };
  });
  vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation(send as never);
  const result = publishHotelSetupPropertySecret({
    admin: { query } as unknown as pg.Client,
    staged,
    ...(operation === "property_logo"
      ? { expectedAssignmentXid: "123" }
      : { expectedVerifier: "private-verifier" }),
    databaseEndpoint: "postgresql://db.internal/test",
    nativeDatabaseUrl: `postgresql://${login}:${"b".repeat(36)}@db.internal/test?sslmode=verify-full`,
  });
  if (mode === "success") {
    await expect(result).resolves.toEqual({ secretArn: arn, versionId: expect.any(String) });
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(connections).toBe(operation === "property_logo" ? 2 : 0);
  } else {
    await expect(result).rejects.toThrow("publication requires recovery inspection");
    if (mode === "readinessCommit")
      await expect(result).rejects.toMatchObject({
        code: "hotel_setup_property_readiness_inspection_required",
      });
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  }
  if (["retarget", "verifier", "wrongAccount", "ready", "actorDrift"].includes(mode))
    expect(send).not.toHaveBeenCalled();
  if (["existing", "unknown"].includes(mode)) expect(send).toHaveBeenCalledOnce();
  expect(closed).toBe(connections);
  if (["sessionLogin", "effectiveLogin", "sessionOid", "effectiveOid"].includes(mode))
    expect(send).not.toHaveBeenCalled();
  if (["xidDrift", "passwordDrift"].includes(mode))
    expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
});
