import { STSClient } from "@aws-sdk/client-sts";
import { createHash } from "node:crypto";
import { expect, it, vi, afterEach } from "vitest";
import type pg from "pg";
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { publishHotelSetupPropertySecret } from "./hotelSetupPropertySecretPublication.js";
vi.mock("./hotelSetupPropertyRoleStaging.js", () => ({
  lockHotelSetupPropertyBootstrapAuthority: vi.fn(),
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
  "wrongAccount",
])("pins property credential publication on %s", async (mode) => {
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
  const propertyId = "10000000-0000-4000-8000-000000000001";
  const operation = "launch_settings" as const;
  const login = `vayada_next_hotel_setup_property_${createHash("sha256").update(`${propertyId}:${operation}`).digest("hex").slice(0, 16)}_123456789abc`;
  const staged = {
    login,
    roleOid: 42,
    propertyId,
    operation,
    organizationId: "10000000-0000-4000-8000-000000000002",
    actorUserId: "10000000-0000-4000-8000-000000000003",
  };
  let identityReads = 0;
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith("SELECT oid")) {
      expect(params).toEqual([42, login, "private-verifier"]);
      identityReads++;
      return {
        rows:
          mode === "verifier" || (mode === "lateDrift" && identityReads === 2) ? [] : [{ oid: 42 }],
      };
    }
    return {
      rows: [
        {
          property_id: mode === "retarget" ? staged.organizationId : propertyId,
          organization_id: staged.organizationId,
          operation_class: operation,
          active: true,
        },
      ],
    };
  });
  let versionId = "",
    payload = "";
  const name = `hotel-setup-command/prod/property/${login}`;
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
  const result = publishHotelSetupPropertySecret({
    admin: { query } as unknown as pg.Client,
    staged,
    expectedVerifier: "private-verifier",
    databaseEndpoint: "postgresql://db.internal/test",
    nativeDatabaseUrl: `postgresql://${login}:${"b".repeat(36)}@db.internal/test?sslmode=verify-full`,
  });
  if (mode === "success") {
    await expect(result).resolves.toEqual({ secretArn: arn, versionId: expect.any(String) });
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  } else {
    await expect(result).rejects.toThrow("publication requires recovery inspection");
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  }
  if (["retarget", "verifier", "wrongAccount"].includes(mode)) expect(send).not.toHaveBeenCalled();
  if (["existing", "unknown"].includes(mode)) expect(send).toHaveBeenCalledOnce();
});
