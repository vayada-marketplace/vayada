import { randomUUID } from "node:crypto";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type pg from "pg";
import { proveFreshHotelSetupNativeCredential } from "./hotelSetupFreshNativeCredential.js";
import { checkHotelSetupCreationCredential } from "./cli/hotelSetupCreationPreflight.js";
import { parseHotelSetupDatabaseUrl } from "./hotelSetupCommandServiceConfig.js";
import {
  hotelSetupOrganizationRolePrefix,
  lockHotelSetupOrganizationBootstrapAuthority,
  type stageHotelSetupOrganizationRole,
} from "./hotelSetupOrganizationRoleStaging.js";

/** Operational activation callback only, after both actual native image proofs.
 * Create-only publication is separate from the final readiness transaction. */
export async function publishHotelSetupOrganizationSecret(input: {
  admin: pg.Client;
  staged: Awaited<ReturnType<typeof stageHotelSetupOrganizationRole>>;
  proveSecondary: typeof checkHotelSetupCreationCredential;
  nativeDatabaseUrl: string;
  databaseEndpoint: string;
}) {
  const { admin, staged } = input;
  const { login, roleOid, organizationId, actorUserId } = staged;
  const scope = Object.freeze({ organizationId, actorUserId });
  const name = `hotel-setup-command/prod/organization/${login}`;
  let secrets: SecretsManagerClient | undefined;
  let sts: STSClient | undefined;
  let failed = false;
  const onError = () => {
    failed = true;
  };
  admin.on("error", onError);
  try {
    if (
      !/^vayada_next_hotel_setup_org_[a-f0-9]{16}_[a-f0-9]{12}$/.test(login) ||
      !login.startsWith(hotelSetupOrganizationRolePrefix(organizationId)) ||
      !Number.isInteger(roleOid) ||
      roleOid <= 0 ||
      typeof input.proveSecondary !== "function"
    )
      throw new Error();
    const url = parseHotelSetupDatabaseUrl(input.nativeDatabaseUrl, input.databaseEndpoint, login);
    const assertPending = async () => {
      await lockHotelSetupOrganizationBootstrapAuthority(admin, scope);
      const assignments = await admin.query<{
        database_login: string;
        organization_id: string;
        credential_role_oid: number | null;
        credential_secret_version: string | null;
        credential_ready_at: Date | null;
      }>(
        `SELECT database_login,organization_id,credential_role_oid,credential_secret_version,credential_ready_at
         FROM platform.hotel_setup_creation_scopes WHERE database_login=$1 OR organization_id=$2::uuid FOR UPDATE`,
        [login, organizationId],
      );
      const assignment = assignments.rows[0];
      if (
        assignments.rows.length !== 1 ||
        assignment?.database_login !== login ||
        assignment.organization_id !== organizationId.toLowerCase() ||
        assignment.credential_role_oid !== null ||
        assignment.credential_secret_version !== null ||
        assignment.credential_ready_at !== null
      )
        throw new Error();
      const identity = await admin.query(
        `SELECT oid FROM pg_catalog.pg_roles r
        WHERE oid=$1::oid AND rolname=$2 AND rolcanlogin AND rolvaliduntil IS NULL
          AND NOT rolsuper AND NOT rolinherit AND NOT rolcreaterole AND NOT rolcreatedb
          AND NOT rolreplication AND NOT rolbypassrls
          AND (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member=r.oid)=1
          AND EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles p ON p.oid=m.roleid
            WHERE m.member=r.oid AND p.rolname='vayada_next_hotel_setup_scope'
              AND m.inherit_option AND NOT m.set_option AND NOT m.admin_option)
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole=r.oid)
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend
            WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')`,
        [roleOid, login],
      );
      if (failed || identity.rows.length !== 1) throw new Error();
      // Reauthenticate the exact login and OID while the authority and assignment locks are held.
      await proveFreshHotelSetupNativeCredential({
        nativeDatabaseUrl: input.nativeDatabaseUrl,
        databaseEndpoint: input.databaseEndpoint,
        login,
        roleOid,
      });
    };
    const proveFresh = async () => {
      const credential = {
        nativeDatabaseUrl: input.nativeDatabaseUrl,
        databaseEndpoint: input.databaseEndpoint,
        login,
        roleOid,
      };
      await proveFreshHotelSetupNativeCredential(credential, (client) =>
        checkHotelSetupCreationCredential(client, scope),
      );
      await proveFreshHotelSetupNativeCredential(credential, (client) =>
        input.proveSecondary(client, scope),
      );
    };
    await admin.query("BEGIN");
    await assertPending();
    await admin.query("COMMIT");
    await proveFresh();
    const resolver = new STSClient({
      region: "eu-west-1",
      endpoint: "https://sts.eu-west-1.amazonaws.com",
      maxAttempts: 1,
    });
    let credentials;
    try {
      credentials = await resolver.config.credentials();
    } finally {
      resolver.destroy();
    }
    sts = new STSClient({
      credentials,
      region: "eu-west-1",
      endpoint: "https://sts.eu-west-1.amazonaws.com",
      maxAttempts: 1,
    });
    const caller = await sts.send(new GetCallerIdentityCommand({}), {
      abortSignal: AbortSignal.timeout(15_000),
    });
    if (caller.Account !== "269416271598") throw new Error();
    secrets = new SecretsManagerClient({
      credentials,
      region: "eu-west-1",
      endpoint: "https://secretsmanager.eu-west-1.amazonaws.com",
      maxAttempts: 1,
    });
    try {
      await secrets.send(new DescribeSecretCommand({ SecretId: name }), {
        abortSignal: AbortSignal.timeout(15_000),
      });
      throw new Error();
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ResourceNotFoundException")
        throw new Error();
    }
    if (failed) throw new Error();
    const versionId = randomUUID();
    const secretString = JSON.stringify({
      username: login,
      password: decodeURIComponent(url.password),
    });
    const version = await secrets.send(
      new CreateSecretCommand({
        Name: name,
        ClientRequestToken: versionId,
        SecretString: secretString,
        Description: "VAY-965 verified organization creation credential",
      }),
      { abortSignal: AbortSignal.timeout(15_000) },
    );
    const prefix = `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${name}-`;
    if (
      version.Name !== name ||
      version.VersionId !== versionId ||
      !version.ARN?.startsWith(prefix) ||
      !/^[A-Za-z0-9]{6}$/.test(version.ARN.slice(prefix.length))
    )
      throw new Error();
    const stored = await secrets.send(
      new GetSecretValueCommand({ SecretId: version.ARN, VersionId: versionId }),
      { abortSignal: AbortSignal.timeout(15_000) },
    );
    if (
      stored.ARN !== version.ARN ||
      stored.Name !== name ||
      stored.VersionId !== versionId ||
      stored.SecretString !== secretString ||
      stored.SecretBinary
    )
      throw new Error();
    await proveFresh();
    const metadata = await secrets.send(new DescribeSecretCommand({ SecretId: name }), {
      abortSignal: AbortSignal.timeout(15_000),
    });
    const current = Object.entries(metadata.VersionIdsToStages ?? {}).filter(([, stages]) =>
      stages.includes("AWSCURRENT"),
    );
    if (
      failed ||
      metadata.ARN !== version.ARN ||
      metadata.Name !== name ||
      metadata.DeletedDate !== undefined ||
      current.length !== 1 ||
      current[0]?.[0] !== versionId ||
      current[0][1].length !== 1
    )
      throw new Error();
    // A secret or proof receipt never admits commands: recheck fresh locked authority.
    await admin.query("BEGIN");
    await assertPending();
    const ready = await admin.query(
      `UPDATE platform.hotel_setup_creation_scopes
      SET credential_role_oid=$2::oid,credential_secret_version=$3,credential_ready_at=pg_catalog.clock_timestamp()
      WHERE database_login=$1 AND organization_id=$4::uuid AND credential_role_oid IS NULL
        AND credential_secret_version IS NULL AND credential_ready_at IS NULL`,
      [login, roleOid, versionId, organizationId],
    );
    if (failed || ready.rowCount !== 1) throw new Error();
    await admin.query("COMMIT");
    if (failed) throw new Error();
    return { secretArn: version.ARN, versionId };
  } catch {
    await admin.query("ROLLBACK").catch(() => undefined);
    // Activation inspects readiness before any same-identity cleanup. Never retry/delete a remote write.
    throw new Error("Hotel setup organization publication requires recovery inspection");
  } finally {
    admin.removeListener("error", onError);
    secrets?.destroy();
    sts?.destroy();
  }
}
