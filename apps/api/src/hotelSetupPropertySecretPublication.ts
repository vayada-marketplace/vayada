import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { proveFreshHotelSetupNativeCredential } from "./hotelSetupFreshNativeCredential.js";
import { checkHotelSetupPropertyCredential } from "./cli/hotelSetupPropertyPreflight.js";
import { parseHotelSetupDatabaseUrl } from "./hotelSetupCommandServiceConfig.js";
import { lockHotelSetupPropertyBootstrapAuthority } from "./hotelSetupPropertyRoleStaging.js";
import type { stageHotelSetupPropertyRole } from "./hotelSetupPropertyRoleStaging.js";

/** Trusted activation callback only, after both compiled native proofs in the same process.
 * Fresh native authentication and current immutable publication precede readiness.
 * Logo also pins its original actor-bound assignment row version. */
export async function publishHotelSetupPropertySecret(input: {
  admin: pg.Client;
  staged: Awaited<ReturnType<typeof stageHotelSetupPropertyRole>>;
  proveSecondary?: (
    client: pg.Client,
    scope: Readonly<Awaited<ReturnType<typeof stageHotelSetupPropertyRole>>>,
  ) => Promise<void>;
  expectedAssignmentXid?: string;
  nativeDatabaseUrl: string;
  databaseEndpoint: string;
}) {
  const { admin, expectedAssignmentXid, nativeDatabaseUrl, databaseEndpoint } = input;
  let secrets: SecretsManagerClient | undefined;
  let sts: STSClient | undefined;
  let readinessCommitAttempted = false;
  const { login, roleOid, propertyId, organizationId, actorUserId, operation, automatic } =
    input.staged;
  const scope = Object.freeze({ propertyId, organizationId, actorUserId, operation, automatic });
  const name = `hotel-setup-command/prod/property/${login}`;
  let failed = false;
  const onError = () => {
    failed = true;
  };
  admin.on("error", onError);
  try {
    const logo = operation === "property_logo";
    if (
      !(
        logo
          ? /^vayada_next_hotel_setup_logo_[a-f0-9]{16}_[a-f0-9]{12}$/
          : /^vayada_next_hotel_setup_property_[a-f0-9]{16}_[a-f0-9]{12}$/
      ).test(login) ||
      !Number.isInteger(roleOid) ||
      roleOid <= 0 ||
      (logo
        ? automatic !== undefined ||
          !/^[1-9][0-9]*$/.test(expectedAssignmentXid ?? "") ||
          input.proveSecondary !== undefined
        : typeof input.proveSecondary !== "function" || expectedAssignmentXid !== undefined)
    )
      throw new Error();
    const url = parseHotelSetupDatabaseUrl(nativeDatabaseUrl, databaseEndpoint, login);
    const identity = async () => {
      const role = await admin.query(
        `SELECT oid FROM pg_catalog.pg_roles r WHERE oid=$1::oid AND rolname=$2
         AND rolcanlogin AND rolvaliduntil IS NULL
         AND NOT rolsuper AND NOT rolinherit AND NOT rolcreaterole AND NOT rolcreatedb
         AND NOT rolreplication AND NOT rolbypassrls
         AND (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member=r.oid)=1
         AND EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles p ON p.oid=m.roleid
           WHERE m.member=r.oid AND p.rolname=$3
           AND m.inherit_option AND NOT m.set_option AND NOT m.admin_option)
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole=r.oid)
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend WHERE
           refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')`,
        [
          roleOid,
          login,
          logo ? "vayada_next_hotel_setup_logo_scope" : "vayada_next_hotel_setup_property_scope",
        ],
      );
      if (failed || role.rows.length !== 1) throw new Error();
      // Logo proofs ran during activation; reauthenticate under the locks instead.
      if (logo)
        await proveFreshHotelSetupNativeCredential({
          nativeDatabaseUrl,
          databaseEndpoint,
          login,
          roleOid,
        });
    };
    const pending = async () => {
      await lockHotelSetupPropertyBootstrapAuthority(admin, scope);
      const assignments = await admin.query<{
        property_id: string;
        organization_id: string;
        operation_class: string;
        actor_user_id: string | null;
        active: boolean;
        credential_role_oid: number | null;
        credential_secret_version: string | null;
        credential_ready_at: Date | null;
        assignment_xid: string;
      }>(
        `SELECT property_id,organization_id,operation_class,actor_user_id,active,
        credential_role_oid,credential_secret_version,credential_ready_at,xmin::text AS assignment_xid
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
        (logo && assigned.actor_user_id !== actorUserId.toLowerCase()) ||
        (logo && assigned.assignment_xid !== expectedAssignmentXid) ||
        !assigned.active ||
        assigned.credential_role_oid !== null ||
        assigned.credential_secret_version !== null ||
        assigned.credential_ready_at !== null
      )
        throw new Error();
      await identity();
    };
    const proveFresh = async () => {
      if (logo) return;
      const credential = { nativeDatabaseUrl, databaseEndpoint, login, roleOid };
      await proveFreshHotelSetupNativeCredential(credential, (client) =>
        checkHotelSetupPropertyCredential(client, scope),
      );
      await proveFreshHotelSetupNativeCredential(credential, (client) =>
        input.proveSecondary!(client, Object.freeze({ login, roleOid, ...scope })),
      );
    };
    await admin.query("BEGIN");
    await pending();
    // Do not retain organization/property locks through external SDK latency.
    // This assignment remains pending; readiness is committed only below.
    await admin.query("COMMIT");
    await proveFresh();
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
    await admin.query("BEGIN");
    await pending();
    const ready = await admin.query<{ database_login: string }>(
      `UPDATE platform.hotel_setup_property_scopes
       SET credential_role_oid=$2::oid,credential_secret_version=$3,
         credential_ready_at=pg_catalog.clock_timestamp()
       WHERE database_login=$1 AND property_id=$4::uuid AND organization_id=$5::uuid
         AND operation_class=$6 AND active AND credential_role_oid IS NULL
         AND credential_secret_version IS NULL AND credential_ready_at IS NULL
         AND actor_user_id IS NOT DISTINCT FROM $7::uuid
         AND ($8::text IS NULL OR xmin=$8::text::xid)
       RETURNING database_login`,
      [
        login,
        roleOid,
        versionId,
        propertyId,
        organizationId,
        operation,
        logo ? actorUserId : null,
        expectedAssignmentXid ?? null,
      ],
    );
    if (failed || ready.rows.length !== 1 || ready.rows[0]?.database_login !== login)
      throw new Error();
    readinessCommitAttempted = true;
    await admin.query("COMMIT");
    if (failed) throw new Error();
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
    admin.removeListener("error", onError);
    secrets?.destroy();
    sts?.destroy();
  }
}
