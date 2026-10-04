import { lockHotelSetupOfflineBootstrap } from "../hotelSetupHelperOwnerGrants.js";
import { pathToFileURL } from "node:url";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { SecretsManagerClient, DescribeSecretCommand } from "@aws-sdk/client-secrets-manager";
import { parseHotelSetupAutomaticConfiguration } from "./hotelSetupAutomaticProvisioning.js";
import { parseHotelSetupDatabaseUrl } from "../hotelSetupCommandServiceConfig.js";
import {
  APPROVED_HOTEL_SETUP_BACKFILLS,
  backfillApprovedHotelSetupOrganizationReadiness,
  isHotelSetupInspectedOid,
  type ApprovedHotelSetupInspectionReceipt,
} from "../hotelSetupApprovedReadinessBackfill.js";
import { grantHotelSetupReadinessReaderColumns } from "../hotelSetupReadinessReaderGrant.js";
import {
  hotelSetupOrganizationConnection,
  lockHotelSetupOrganizationBootstrapAuthority,
} from "../hotelSetupOrganizationRoleStaging.js";
import { createHotelSetupNativeSecretReader } from "../hotelSetupNativeSecretReader.js";
import type { checkHotelSetupCreationCredential } from "./hotelSetupCreationPreflight.js";

export type ApprovedReadinessInspection = {
  organizations: ApprovedHotelSetupInspectionReceipt[];
  readers: { expectedCreationReaderOid: number; expectedPropertyReaderOid: number };
};
const readerLogins = [
  "vayada_next_hotel_setup_creation_reader",
  "vayada_next_hotel_setup_reader",
] as const;

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys.sort().join(",")
  );
}

/** Apply accepts an explicit frozen inspection, never a guessed OID/current secret. */
export function parseApprovedReadinessInspection(raw: string): ApprovedReadinessInspection {
  const value: unknown = JSON.parse(raw);
  if (
    !exactKeys(value, ["organizations", "readers"]) ||
    !Array.isArray(value.organizations) ||
    value.organizations.length !== 2 ||
    !exactKeys(value.readers, ["expectedCreationReaderOid", "expectedPropertyReaderOid"])
  )
    throw new Error();
  const organizations = APPROVED_HOTEL_SETUP_BACKFILLS.map((binding, index) => {
    const item: unknown = (value.organizations as unknown[])[index];
    if (
      !exactKeys(item, [
        "organizationId",
        "actorUserId",
        "login",
        "expectedRoleOid",
        "secretVersion",
      ]) ||
      item.organizationId !== binding.organizationId ||
      item.actorUserId !== binding.actorUserId ||
      item.login !== binding.login ||
      !isHotelSetupInspectedOid(item.expectedRoleOid) ||
      typeof item.secretVersion !== "string" ||
      !/^[A-Za-z0-9-]{32,64}$/.test(item.secretVersion)
    )
      throw new Error();
    return { ...binding, expectedRoleOid: item.expectedRoleOid, secretVersion: item.secretVersion };
  });
  const { expectedCreationReaderOid, expectedPropertyReaderOid } = value.readers;
  if (
    !isHotelSetupInspectedOid(expectedCreationReaderOid) ||
    !isHotelSetupInspectedOid(expectedPropertyReaderOid) ||
    new Set([
      ...organizations.map((item) => item.expectedRoleOid),
      expectedCreationReaderOid,
      expectedPropertyReaderOid,
    ]).size !== 4
  )
    throw new Error();
  return { organizations, readers: { expectedCreationReaderOid, expectedPropertyReaderOid } };
}

export function parseApprovedReadinessConfiguration(env: NodeJS.ProcessEnv) {
  const mode = env.HOTEL_SETUP_APPROVED_READINESS_MODE;
  if (mode !== "inspect" && mode !== "apply") throw new Error();
  const config = parseHotelSetupAutomaticConfiguration({
    ...env,
    HOTEL_SETUP_AUTOMATIC_MODE: "organization",
  });
  if (mode === "inspect" && env.HOTEL_SETUP_APPROVED_READINESS_INSPECTION !== undefined)
    throw new Error();
  return {
    mode,
    adminDatabaseUrl: config.adminDatabaseUrl,
    databaseEndpoint: config.databaseEndpoint,
    inspection:
      mode === "apply"
        ? parseApprovedReadinessInspection(env.HOTEL_SETUP_APPROVED_READINESS_INSPECTION ?? "")
        : undefined,
  };
}

async function officialClients() {
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
  const sts = new STSClient({
    credentials,
    region: "eu-west-1",
    endpoint: "https://sts.eu-west-1.amazonaws.com",
    maxAttempts: 1,
  });
  try {
    const caller = await sts.send(new GetCallerIdentityCommand({}), {
      abortSignal: AbortSignal.timeout(15_000),
    });
    if (caller.Account !== "269416271598") throw new Error();
  } finally {
    sts.destroy();
  }
  return new SecretsManagerClient({
    credentials,
    region: "eu-west-1",
    endpoint: "https://secretsmanager.eu-west-1.amazonaws.com",
    maxAttempts: 1,
  });
}

/** No data writes or secret-value reads. Release all authority locks before AWS. */
export async function inspectApprovedReadiness(config: {
  adminDatabaseUrl: string;
  databaseEndpoint: string;
}): Promise<ApprovedReadinessInspection> {
  const admin = hotelSetupOrganizationConnection(config.adminDatabaseUrl, config.databaseEndpoint);
  let failed = false;
  admin.on("error", () => {
    failed = true;
  });
  const organizations: ApprovedHotelSetupInspectionReceipt[] = [];
  let readers: ApprovedReadinessInspection["readers"];
  try {
    await admin.connect();
    await lockHotelSetupOfflineBootstrap(admin);
    await admin.query("BEGIN");
    for (const binding of APPROVED_HOTEL_SETUP_BACKFILLS) {
      await lockHotelSetupOrganizationBootstrapAuthority(admin, binding);
      const assignments = await admin.query<{ database_login: string; organization_id: string }>(
        `SELECT database_login,organization_id FROM platform.hotel_setup_creation_scopes
         WHERE database_login=$1 OR organization_id=$2::uuid FOR SHARE`,
        [binding.login, binding.organizationId],
      );
      if (
        assignments.rows.length !== 1 ||
        assignments.rows[0]?.database_login !== binding.login ||
        assignments.rows[0]?.organization_id !== binding.organizationId
      )
        throw new Error();
      const roles = await admin.query<{ oid: number }>(
        `SELECT r.oid FROM pg_catalog.pg_authid r WHERE r.rolname=$1 AND r.rolcanlogin
         AND r.rolpassword IS NOT NULL AND r.rolvaliduntil IS NULL
         AND NOT r.rolsuper AND NOT r.rolinherit AND NOT r.rolcreaterole AND NOT r.rolcreatedb
         AND NOT r.rolreplication AND NOT r.rolbypassrls
         AND (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member=r.oid)=1
         AND EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles p ON p.oid=m.roleid
           WHERE m.member=r.oid AND p.rolname='vayada_next_hotel_setup_scope'
             AND m.inherit_option AND NOT m.set_option AND NOT m.admin_option)
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole=r.oid)
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend
           WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')`,
        [binding.login],
      );
      if (roles.rows.length !== 1 || !isHotelSetupInspectedOid(roles.rows[0]?.oid))
        throw new Error();
      organizations.push({ ...binding, expectedRoleOid: roles.rows[0]!.oid, secretVersion: "" });
    }
    const oids: number[] = [];
    for (const login of readerLogins) {
      const roles = await admin.query<{ oid: number }>(
        `SELECT r.oid FROM pg_catalog.pg_authid r WHERE r.rolname=$1 AND r.rolcanlogin
         AND r.rolvaliduntil IS NULL AND NOT r.rolsuper AND NOT r.rolinherit
         AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AND NOT r.rolbypassrls
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid)
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole=r.oid)
         AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend
           WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')`,
        [login],
      );
      if (roles.rows.length !== 1 || !isHotelSetupInspectedOid(roles.rows[0]?.oid))
        throw new Error();
      oids.push(roles.rows[0]!.oid);
    }
    readers = { expectedCreationReaderOid: oids[0]!, expectedPropertyReaderOid: oids[1]! };
    if (failed) throw new Error();
    await admin.query("ROLLBACK");
    if (failed) throw new Error();
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
  const secrets = await officialClients();
  try {
    for (const item of organizations) {
      const name = `hotel-setup-command/prod/organization/${item.login}`;
      const metadata = await secrets.send(new DescribeSecretCommand({ SecretId: name }), {
        abortSignal: AbortSignal.timeout(15_000),
      });
      const prefix = `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${name}-`;
      const versions = Object.entries(metadata.VersionIdsToStages ?? {});
      if (
        metadata.Name !== name ||
        !metadata.ARN?.startsWith(prefix) ||
        !/^[A-Za-z0-9]{6}$/.test(metadata.ARN.slice(prefix.length)) ||
        metadata.DeletedDate ||
        versions.length !== 1 ||
        !/^[A-Za-z0-9-]{32,64}$/.test(versions[0]![0]) ||
        versions[0]![1].length !== 1 ||
        versions[0]![1][0] !== "AWSCURRENT"
      )
        throw new Error();
      item.secretVersion = versions[0]![0];
    }
    return parseApprovedReadinessInspection(JSON.stringify({ organizations, readers }));
  } finally {
    secrets.destroy();
  }
}

export async function applyApprovedReadiness(
  config: {
    adminDatabaseUrl: string;
    databaseEndpoint: string;
    inspection: ApprovedReadinessInspection;
  },
  proveSecondary: typeof checkHotelSetupCreationCredential,
) {
  const inspection = parseApprovedReadinessInspection(JSON.stringify(config.inspection));
  const secrets = await officialClients();
  try {
    const read = createHotelSetupNativeSecretReader(secrets);
    // Validate both pinned payloads before the first administrative grant.
    const urls: string[] = [];
    for (const item of inspection.organizations) {
      const payload = await read(
        `hotel-setup-command/prod/organization/${item.login}`,
        item.secretVersion,
      );
      if (
        !exactKeys(payload, ["username", "password"]) ||
        payload.username !== item.login ||
        typeof payload.password !== "string"
      )
        throw new Error();
      const url = new URL(config.databaseEndpoint);
      url.username = item.login;
      url.password = payload.password;
      url.search = "?sslmode=verify-full";
      parseHotelSetupDatabaseUrl(url.toString(), config.databaseEndpoint, item.login);
      urls.push(url.toString());
    }
    const readers = await grantHotelSetupReadinessReaderColumns({
      ...config,
      ...inspection.readers,
    });
    const organizations = [];
    for (const [index, inspectionReceipt] of inspection.organizations.entries())
      organizations.push(
        await backfillApprovedHotelSetupOrganizationReadiness({
          adminDatabaseUrl: config.adminDatabaseUrl,
          databaseEndpoint: config.databaseEndpoint,
          nativeDatabaseUrl: urls[index]!,
          inspectionReceipt,
          proveSecondary,
        }),
      );
    return { status: "PASS", mode: "apply", organizations, readers };
  } finally {
    secrets.destroy();
  }
}

export async function runApprovedReadinessBackfill(env: NodeJS.ProcessEnv = process.env) {
  try {
    if (import.meta.url !== "file:///app/apps/api/dist/cli/hotelSetupApprovedReadinessBackfill.js")
      throw new Error();
    const config = parseApprovedReadinessConfiguration(env);
    if (config.mode === "inspect") {
      console.log(
        JSON.stringify({
          status: "PASS",
          mode: "inspect",
          inspection: await inspectApprovedReadiness(config),
        }),
      );
    } else {
      const rollback: {
        checkHotelSetupCreationCredential?: typeof checkHotelSetupCreationCredential;
      } = await import(
        pathToFileURL("/proof/rollback/apps/api/dist/cli/hotelSetupCreationPreflight.js").href
      );
      if (typeof rollback.checkHotelSetupCreationCredential !== "function" || !config.inspection)
        throw new Error();
      console.log(
        JSON.stringify(
          await applyApprovedReadiness(
            { ...config, inspection: config.inspection },
            rollback.checkHotelSetupCreationCredential,
          ),
        ),
      );
    }
    return 0;
  } catch {
    console.error(
      JSON.stringify({
        status: "FAIL",
        code: "hotel_setup_approved_readiness_inspection_required",
      }),
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const timer = setTimeout(() => {
    console.error(
      JSON.stringify({ status: "FAIL", code: "hotel_setup_approved_readiness_deadline" }),
    );
    process.exit(1);
  }, 170_000);
  try {
    process.exitCode = await runApprovedReadinessBackfill();
  } finally {
    clearTimeout(timer);
  }
}
