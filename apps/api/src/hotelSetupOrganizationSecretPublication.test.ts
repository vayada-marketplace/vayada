import { STSClient } from "@aws-sdk/client-sts";
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { publishHotelSetupOrganizationSecret } from "./hotelSetupOrganizationSecretPublication.js";
import {
  hotelSetupOrganizationRolePrefix,
  lockHotelSetupOrganizationBootstrapAuthority,
} from "./hotelSetupOrganizationRoleStaging.js";

vi.mock("./hotelSetupOrganizationRoleStaging.js", async (load) => ({
  ...(await load<typeof import("./hotelSetupOrganizationRoleStaging.js")>()),
  lockHotelSetupOrganizationBootstrapAuthority: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  "success",
  "existing",
  "unknown",
  "version",
  "readback",
  "retarget",
  "verifier",
  "lateDrift",
  "lateActor",
  "alreadyReady",
  "wrongAccount",
  "readyCommit",
])("admits only pinned organization publication on %s", async (mode) => {
  vi.stubEnv("AWS_ACCESS_KEY_ID", "synthetic-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-secret");
  vi.stubEnv("AWS_PROFILE", undefined);
  vi.stubEnv("AWS_REGION", "us-east-1");
  vi.stubEnv("AWS_ENDPOINT_URL", "https://wrong.example");
  vi.spyOn(STSClient.prototype, "send").mockImplementation(async function (this: STSClient) {
    expect(await this.config.region()).toBe("eu-west-1");
    expect((await this.config.endpoint!()).hostname).toBe("sts.eu-west-1.amazonaws.com");
    return { Account: mode === "wrongAccount" ? "000000000000" : "269416271598" };
  } as never);
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const login = `${hotelSetupOrganizationRolePrefix(organizationId)}123456789abc`;
  const staged = {
    login,
    roleOid: 42,
    organizationId,
    actorUserId: "22222222-2222-4222-8222-222222222222",
  };
  let identityReads = 0;
  let commits = 0;
  let readyWritten = false;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("SELECT oid")) {
      expect(params).toEqual([42, login, "private-verifier"]);
      identityReads++;
      return {
        rows:
          mode === "verifier" || (mode === "lateDrift" && identityReads === 2) ? [] : [{ oid: 42 }],
      };
    }
    if (sql.startsWith("SELECT database_login"))
      return {
        rows: [
          {
            database_login: login,
            organization_id: mode === "retarget" ? staged.actorUserId : organizationId,
            credential_role_oid: mode === "alreadyReady" ? 42 : null,
            credential_secret_version: null,
            credential_ready_at: null,
          },
        ],
      };
    if (sql.startsWith("UPDATE")) {
      readyWritten = true;
      return { rowCount: 1, rows: [] };
    }
    if (sql === "COMMIT" && ++commits === 2 && mode === "readyCommit")
      throw new Error("lost acknowledgement");
    return { rows: [] };
  });
  vi.mocked(lockHotelSetupOrganizationBootstrapAuthority).mockImplementation(async () => {
    if (mode === "lateActor" && identityReads === 1) throw new Error("revoked actor");
  });
  let versionId = "",
    payload = "";
  const name = `hotel-setup-command/prod/organization/${login}`;
  const arn = `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${name}-123abc`;
  const send = vi.fn(async function (this: SecretsManagerClient, command: unknown) {
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
  const result = publishHotelSetupOrganizationSecret({
    admin: { query, on: vi.fn(), removeListener: vi.fn() } as unknown as pg.Client,
    staged,
    expectedVerifier: "private-verifier",
    databaseEndpoint: "postgresql://db.internal/test",
    nativeDatabaseUrl: `postgresql://${login}:${"b".repeat(36)}@db.internal/test?sslmode=verify-full`,
  });
  if (mode === "success") {
    await expect(result).resolves.toEqual({ secretArn: arn, versionId: expect.any(String) });
    expect(query.mock.calls.at(-2)?.[0]).toContain(
      "credential_ready_at=pg_catalog.clock_timestamp()",
    );
    expect(query.mock.calls.at(-2)?.[1]).toEqual([login, 42, versionId, organizationId]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  } else {
    await expect(result).rejects.toThrow("publication requires recovery inspection");
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  }
  expect(readyWritten).toBe(["success", "readyCommit"].includes(mode));
  if (["retarget", "verifier", "alreadyReady", "wrongAccount"].includes(mode))
    expect(send).not.toHaveBeenCalled();
  if (["existing", "unknown"].includes(mode)) expect(send).toHaveBeenCalledOnce();
});
