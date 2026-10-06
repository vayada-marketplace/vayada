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
import { proveFreshHotelSetupNativeCredential } from "./hotelSetupFreshNativeCredential.js";
import { checkHotelSetupPropertyCredential } from "./cli/hotelSetupPropertyPreflight.js";
import { publishHotelSetupPropertySecret } from "./hotelSetupPropertySecretPublication.js";
import { lockHotelSetupPropertyBootstrapAuthority } from "./hotelSetupPropertyRoleStaging.js";
vi.mock("./hotelSetupFreshNativeCredential.js", () => ({
  proveFreshHotelSetupNativeCredential: vi.fn(),
}));
vi.mock("./cli/hotelSetupPropertyPreflight.js", () => ({
  checkHotelSetupPropertyCredential: vi.fn(),
}));
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
    "identity",
    "lateDrift",
    "wrongAccount",
    "ready",
    "revoked",
    "readinessCommit",
    "lateRetarget",
    "lateReady",
    "native",
    "lateNative",
    "metadataVersion",
    "metadataIdentity",
    "actorDrift",
    "xidDrift",
  ].flatMap((mode) =>
    (["launch_settings", "property_logo"] as const)
      .filter(
        (operation) => !["actorDrift", "xidDrift"].includes(mode) || operation === "property_logo",
      )
      // Logo keeps its reviewed RDS publication without the AWSCURRENT metadata step.
      .filter(
        (operation) =>
          !["metadataVersion", "metadataIdentity"].includes(mode) || operation !== "property_logo",
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
  const logo = operation === "property_logo";
  const login = `vayada_next_hotel_setup_${logo ? "logo" : "property"}_${createHash("sha256").update(`${propertyId}:${operation}`).digest("hex").slice(0, 16)}_123456789abc`;
  const staged = {
    login,
    roleOid: 42,
    propertyId,
    operation,
    organizationId: "10000000-0000-4000-8000-000000000002",
    actorUserId: "10000000-0000-4000-8000-000000000003",
  };
  let identityReads = 0;
  let assignmentReads = 0,
    commits = 0,
    transaction = false;
  let nativeProofs = 0;
  const secondary = vi.fn(async () => undefined);
  vi.mocked(checkHotelSetupPropertyCredential).mockResolvedValue(undefined);
  vi.mocked(proveFreshHotelSetupNativeCredential).mockImplementation(async (credential, prove) => {
    // Logo reauthenticates under the authority/assignment locks, like the reviewed RDS path.
    expect(transaction).toBe(logo);
    expect(credential.login).toBe(login);
    expect(credential.roleOid).toBe(42);
    nativeProofs++;
    // Logo authenticates within each pending check; other purposes prove twice per checkpoint.
    if (mode === "native" || (mode === "lateNative" && nativeProofs === (logo ? 2 : 3)))
      throw new Error();
    expect(prove === undefined).toBe(logo);
    await prove?.({ checkpoint: nativeProofs } as unknown as pg.Client);
  });
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
        logo ? staged.actorUserId : null,
        logo ? "123" : null,
      ]);
      expect(identityReads).toBe(2);
      expect(send).toHaveBeenCalledTimes(logo ? 3 : 4);
      return { rows: [{ database_login: login }] };
    }
    if (sql.startsWith("SELECT oid")) {
      expect(sql).toContain("FROM pg_catalog.pg_roles");
      expect(sql).not.toContain("rolpassword");
      expect(params).toEqual([
        42,
        login,
        logo ? "vayada_next_hotel_setup_logo_scope" : "vayada_next_hotel_setup_property_scope",
      ]);
      identityReads++;
      return {
        rows:
          mode === "identity" || (mode === "lateDrift" && identityReads === 2) ? [] : [{ oid: 42 }],
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
          actor_user_id: logo ? (mode === "actorDrift" ? propertyId : staged.actorUserId) : null,
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
      if (versionId)
        return {
          ARN: mode === "metadataIdentity" ? "other" : arn,
          Name: name,
          VersionIdsToStages: {
            [mode === "metadataVersion" ? "other" : versionId]: ["AWSCURRENT"],
          },
        };
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
    admin: { query, on: vi.fn(), removeListener: vi.fn() } as unknown as pg.Client,
    staged,
    ...(logo ? { expectedAssignmentXid: "123" } : { proveSecondary: secondary }),
    databaseEndpoint: "postgresql://db.internal/test",
    nativeDatabaseUrl: `postgresql://${login}:${"b".repeat(36)}@db.internal/test?sslmode=verify-full`,
  });
  if (mode === "success") {
    await expect(result).resolves.toEqual({ secretArn: arn, versionId: expect.any(String) });
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(proveFreshHotelSetupNativeCredential).toHaveBeenCalledTimes(logo ? 2 : 4);
    expect(checkHotelSetupPropertyCredential).toHaveBeenCalledTimes(logo ? 0 : 2);
    expect(secondary).toHaveBeenCalledTimes(logo ? 0 : 2);
  } else {
    await expect(result).rejects.toThrow("publication requires recovery inspection");
    if (mode === "readinessCommit")
      await expect(result).rejects.toMatchObject({
        code: "hotel_setup_property_readiness_inspection_required",
      });
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  }
  if (["retarget", "identity", "wrongAccount", "ready", "native", "actorDrift"].includes(mode))
    expect(send).not.toHaveBeenCalled();
  if (["xidDrift", "lateNative"].includes(mode))
    expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
  if (["existing", "unknown"].includes(mode)) expect(send).toHaveBeenCalledOnce();
});
