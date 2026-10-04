import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { parseHotelSetupDatabaseUrl } from "./hotelSetupCommandServiceConfig.js";
import { lockHotelSetupPropertyBootstrapAuthority } from "./hotelSetupPropertyRoleStaging.js";
import type { stageHotelSetupPropertyRole } from "./hotelSetupPropertyRoleStaging.js";

/** Trusted activation callback only, after both compiled native proofs in the same process.
 * Caller owns the connected admin client and exact verifier cleanup boundary. */
export async function publishHotelSetupPropertySecret(input: {
  admin: pg.Client;
  staged: Awaited<ReturnType<typeof stageHotelSetupPropertyRole>>;
  expectedVerifier: string;
  nativeDatabaseUrl: string;
  databaseEndpoint: string;
}) {
  const { admin, expectedVerifier, nativeDatabaseUrl, databaseEndpoint } = input;
  let secrets: SecretsManagerClient | undefined;
  let sts: STSClient | undefined;
  let readinessCommitAttempted = false;
  const { login, roleOid, propertyId, organizationId, actorUserId, operation, automatic } =
    input.staged;
  const scope = Object.freeze({ propertyId, organizationId, actorUserId, operation, automatic });
  const name = `hotel-setup-command/prod/property/${login}`;
  try {
    if (
      !/^vayada_next_hotel_setup_property_[a-f0-9]{16}_[a-f0-9]{12}$/.test(login) ||
      !expectedVerifier
    )
      throw new Error();
    const url = parseHotelSetupDatabaseUrl(nativeDatabaseUrl, databaseEndpoint, login);
    const identity = async () => {
      const role = await admin.query(
        `SELECT oid FROM pg_catalog.pg_authid r WHERE oid=$1::oid AND rolname=$2
         AND rolpassword=$3 AND rolcanlogin AND rolvaliduntil IS NULL
         AND NOT rolsuper AND NOT rolinherit AND NOT rolcreaterole AND NOT rolcreatedb
         AND NOT rolreplication AND NOT rolbypassrls
         AND (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member=r.oid)=1
         AND EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles p ON p.oid=m.roleid
           WHERE m.member=r.oid AND p.rolname='vayada_next_hotel_setup_property_scope'
           AND m.inherit_option AND NOT m.set_option AND NOT m.admin_option)
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole=r.oid)
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend WHERE
           refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')`,
        [roleOid, login, expectedVerifier],
      );
      if (role.rows.length !== 1) throw new Error();
    };
    await admin.query("BEGIN");
    await lockHotelSetupPropertyBootstrapAuthority(admin, scope);
    const assignments = await admin.query<{
      property_id: string;
      organization_id: string;
      operation_class: string;
      active: boolean;
      credential_role_oid: number | null;
      credential_secret_version: string | null;
      credential_ready_at: Date | null;
    }>(
      `SELECT property_id,organization_id,operation_class,active,
        credential_role_oid,credential_secret_version,credential_ready_at
       FROM platform.hotel_setup_property_scopes
       WHERE database_login=$1 OR (property_id=$2::uuid AND operation_class=$3) FOR UPDATE`,
      [login, propertyId, operation],
    );
    const assigned = assignments.rows[0];
    if (
      assignments.rows.length !== 1 ||
      assigned?.property_id !== propertyId.toLowerCase() ||
      assigned.organization_id !== organizationId.toLowerCase() ||
      assigned.operation_class !== operation ||
      !assigned.active ||
      assigned.credential_role_oid !== null ||
      assigned.credential_secret_version !== null ||
      assigned.credential_ready_at !== null
    )
      throw new Error();
    await identity();
    // Resolve once, then pin the same credentials and official endpoints for identity and writes.
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
    // Never overwrite or adopt an existing, deleted or partially published secret.
    try {
      await secrets.send(new DescribeSecretCommand({ SecretId: name }), {
        abortSignal: AbortSignal.timeout(15_000),
      });
      throw new Error();
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ResourceNotFoundException")
        throw new Error();
    }
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
        Description: "VAY-1092 verified property-purpose credential",
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
      new GetSecretValueCommand({
        SecretId: version.ARN,
        VersionId: versionId,
      }),
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
    await lockHotelSetupPropertyBootstrapAuthority(admin, scope);
    await identity();
    const ready = await admin.query<{ database_login: string }>(
      `UPDATE platform.hotel_setup_property_scopes
       SET credential_role_oid=$2::oid,credential_secret_version=$3,
         credential_ready_at=pg_catalog.clock_timestamp()
       WHERE database_login=$1 AND property_id=$4::uuid AND organization_id=$5::uuid
         AND operation_class=$6 AND active AND credential_role_oid IS NULL
         AND credential_secret_version IS NULL AND credential_ready_at IS NULL
       RETURNING database_login`,
      [login, roleOid, versionId, propertyId, organizationId, operation],
    );
    if (ready.rows.length !== 1 || ready.rows[0]?.database_login !== login) throw new Error();
    readinessCommitAttempted = true;
    await admin.query("COMMIT");
    return { secretArn: version.ARN, versionId };
  } catch {
    await admin.query("ROLLBACK").catch(() => undefined);
    // A remote write can succeed despite a lost response. Never delete or retry it here.
    throw Object.assign(
      new Error("Hotel setup property publication requires recovery inspection"),
      {
        code: readinessCommitAttempted
          ? "hotel_setup_property_readiness_inspection_required"
          : undefined,
      },
    );
  } finally {
    secrets?.destroy();
    sts?.destroy();
  }
}
