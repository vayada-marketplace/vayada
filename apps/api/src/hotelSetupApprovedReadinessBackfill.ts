import { lockHotelSetupOfflineBootstrap } from "./hotelSetupHelperOwnerGrants.js";
import type pg from "pg";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { DescribeSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { checkHotelSetupCreationCredential } from "./cli/hotelSetupCreationPreflight.js";
import { parseHotelSetupDatabaseUrl } from "./hotelSetupCommandServiceConfig.js";
import { createHotelSetupNativeSecretReader } from "./hotelSetupNativeSecretReader.js";
import {
  hotelSetupOrganizationConnection,
  lockHotelSetupOrganizationBootstrapAuthority,
} from "./hotelSetupOrganizationRoleStaging.js";

/** Protected, drained offline procedure only. These are explicitly approved existing bindings. */
export const APPROVED_HOTEL_SETUP_BACKFILLS = Object.freeze([
  Object.freeze({
    organizationId: "6a717155-a188-45f3-87e5-5c8408f41a87",
    actorUserId: "b9eec40b-2e2d-4ff1-b3d4-6d6e03bb58d9",
    login: "vayada_next_hotel_setup_org_c0be02f6ee4d481aadb8c7eca98d74c1",
  }),
  Object.freeze({
    organizationId: "2734e584-022d-432a-9637-ccb0cce59c53",
    actorUserId: "a729d719-2297-4be7-8f7a-12bdf87da1b3",
    login: "vayada_next_hotel_setup_org_74adc91d74b84f11bacdf2b961cc8438",
  }),
]);

/** OID and version must be supplied by the reviewed read-only inspection receipt.
 * There is deliberately no lookup/default that adopts the current role or secret. */
export type ApprovedHotelSetupInspectionReceipt = {
  organizationId: string;
  actorUserId: string;
  login: string;
  expectedRoleOid: number;
  secretVersion: string;
};

type Assignment = {
  database_login: string;
  organization_id: string;
  credential_role_oid: number | null;
  credential_secret_version: string | null;
  ready_at: string | null;
  assignment_xid: string;
};

export function isHotelSetupInspectedOid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 4294967295;
}

async function lockApprovedIdentity(
  admin: pg.Client,
  receipt: Readonly<ApprovedHotelSetupInspectionReceipt>,
) {
  await lockHotelSetupOrganizationBootstrapAuthority(admin, receipt);
  const assignments = await admin.query<Assignment>(
    `SELECT database_login,organization_id,credential_role_oid,credential_secret_version,
      credential_ready_at::text AS ready_at,xmin::text AS assignment_xid
     FROM platform.hotel_setup_creation_scopes
     WHERE database_login=$1 OR organization_id=$2::uuid FOR UPDATE`,
    [receipt.login, receipt.organizationId],
  );
  const assignment = assignments.rows[0];
  if (
    assignments.rows.length !== 1 ||
    assignment?.database_login !== receipt.login ||
    assignment.organization_id !== receipt.organizationId
  )
    throw new Error();
  const identities = await admin.query<{ oid: number }>(
    `SELECT r.oid FROM pg_catalog.pg_roles r
     WHERE r.oid=$1::oid AND r.rolname=$2 AND r.rolcanlogin
       AND r.rolvaliduntil IS NULL
       AND NOT r.rolsuper AND NOT r.rolinherit AND NOT r.rolcreaterole AND NOT r.rolcreatedb
       AND NOT r.rolreplication AND NOT r.rolbypassrls
       AND (SELECT count(*) FROM pg_catalog.pg_auth_members WHERE member=r.oid)=1
       AND EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles p ON p.oid=m.roleid
         WHERE m.member=r.oid AND p.rolname='vayada_next_hotel_setup_scope'
           AND m.inherit_option AND NOT m.set_option AND NOT m.admin_option)
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting WHERE setrole=r.oid)
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend
         WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')`,
    [receipt.expectedRoleOid, receipt.login],
  );
  if (identities.rows.length !== 1 || identities.rows[0]?.oid !== receipt.expectedRoleOid)
    throw new Error();
  return { assignment };
}

/** Every checkpoint authenticates a new connection; existing sessions cannot detect rotation. */
async function authenticateApprovedCredential(
  input: { nativeDatabaseUrl: string; databaseEndpoint: string },
  receipt: Readonly<ApprovedHotelSetupInspectionReceipt>,
  prove?: typeof checkHotelSetupCreationCredential,
) {
  const native = hotelSetupOrganizationConnection(input.nativeDatabaseUrl, input.databaseEndpoint);
  let failed = false;
  native.on("error", () => {
    failed = true;
  });
  try {
    await native.connect();
    const authenticated = await native.query<{
      session_login: string;
      effective_login: string;
      role_oid: number;
      effective_oid: number;
    }>(
      "SELECT session_user::text AS session_login,current_user::text AS effective_login,session_user::regrole::oid AS role_oid,current_user::regrole::oid AS effective_oid",
    );
    const identity = authenticated.rows[0];
    if (
      authenticated.rows.length !== 1 ||
      identity?.session_login !== receipt.login ||
      identity.effective_login !== receipt.login ||
      identity.role_oid !== receipt.expectedRoleOid ||
      identity.effective_oid !== receipt.expectedRoleOid
    )
      throw new Error();
    if (prove) await prove(native, receipt);
    if (failed) throw new Error();
  } finally {
    await native.end();
  }
}

function isPending(assignment: Assignment) {
  return (
    assignment.credential_role_oid === null &&
    assignment.credential_secret_version === null &&
    assignment.ready_at === null
  );
}

function isExactReady(assignment: Assignment, receipt: ApprovedHotelSetupInspectionReceipt) {
  return (
    assignment.credential_role_oid === receipt.expectedRoleOid &&
    assignment.credential_secret_version === receipt.secretVersion &&
    assignment.ready_at !== null
  );
}

/** No rotation, creation, secret writes, automatic retry or failure cleanup of an existing identity. */
export async function backfillApprovedHotelSetupOrganizationReadiness(input: {
  adminDatabaseUrl: string;
  nativeDatabaseUrl: string;
  databaseEndpoint: string;
  inspectionReceipt: ApprovedHotelSetupInspectionReceipt;
  proveSecondary: typeof checkHotelSetupCreationCredential;
}) {
  const receipt = Object.freeze({ ...input.inspectionReceipt });
  const { adminDatabaseUrl, nativeDatabaseUrl, databaseEndpoint, proveSecondary } = input;
  let admin: pg.Client | undefined;
  let secrets: SecretsManagerClient | undefined;
  let sts: STSClient | undefined;
  let failed = false,
    incompleteGrant = false;
  let readyCommitAttempted = false,
    readyXid = "",
    nativePassword = "";
  const onError = () => {
    failed = true;
  };
  const proveFresh = async () => {
    for (const prove of [checkHotelSetupCreationCredential, proveSecondary])
      await authenticateApprovedCredential(input, receipt, prove);
  };
  const assertCurrentCredential = async () => {
    if (!secrets || !nativePassword) throw new Error();
    const stored = await createHotelSetupNativeSecretReader(secrets)(
      `hotel-setup-command/prod/organization/${receipt.login}`,
      receipt.secretVersion,
    );
    if (
      !stored ||
      typeof stored !== "object" ||
      Array.isArray(stored) ||
      Object.keys(stored).sort().join(",") !== "password,username" ||
      (stored as { username?: unknown }).username !== receipt.login ||
      (stored as { password?: unknown }).password !== nativePassword
    )
      throw new Error();
    const name = `hotel-setup-command/prod/organization/${receipt.login}`;
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
      versions[0]![0] !== receipt.secretVersion ||
      versions[0]![1].length !== 1 ||
      versions[0]![1][0] !== "AWSCURRENT"
    )
      throw new Error();
  };
  const result = (status: "ready" | "already_ready" | "ready_commit_inspected") => ({
    status,
    organizationId: receipt.organizationId,
    login: receipt.login,
    roleOid: receipt.expectedRoleOid,
    secretVersion: receipt.secretVersion,
  });
  try {
    if (
      !APPROVED_HOTEL_SETUP_BACKFILLS.some(
        (binding) =>
          binding.organizationId === receipt.organizationId &&
          binding.actorUserId === receipt.actorUserId &&
          binding.login === receipt.login,
      ) ||
      !isHotelSetupInspectedOid(receipt.expectedRoleOid) ||
      !/^[A-Za-z0-9-]{32,64}$/.test(receipt.secretVersion) ||
      typeof proveSecondary !== "function"
    )
      throw new Error();
    const url = parseHotelSetupDatabaseUrl(nativeDatabaseUrl, databaseEndpoint, receipt.login);
    nativePassword = decodeURIComponent(url.password);
    admin = hotelSetupOrganizationConnection(adminDatabaseUrl, databaseEndpoint);
    admin.on("error", onError);
    admin.on("notice", (notice) => {
      if (notice.code === "01007") incompleteGrant = true;
    });
    await admin.connect();
    await lockHotelSetupOfflineBootstrap(admin);
    await admin.query("SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1,0))", [
      `hotel_setup_organization:${receipt.organizationId}`,
    ]);
    await admin.query("BEGIN");
    const initial = await lockApprovedIdentity(admin, receipt);
    const replay = isExactReady(initial.assignment, receipt);
    if (!replay && !isPending(initial.assignment)) throw new Error();
    await authenticateApprovedCredential(input, receipt);
    if (!replay)
      await admin.query(
        `GRANT INSERT(organization_id,product,entitlement_key,status,resource_product,resource_type,resource_id,metadata)
       ON identity.product_entitlements TO ${admin.escapeIdentifier(receipt.login)}`,
      );
    if (failed || incompleteGrant) throw new Error();
    await admin.query("COMMIT");
    if (failed) throw new Error();

    await proveFresh();
    if (failed) throw new Error();

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
    await assertCurrentCredential();
    await proveFresh();
    await assertCurrentCredential();
    if (failed) throw new Error();

    await admin.query("BEGIN");
    const current = await lockApprovedIdentity(admin, receipt);
    if (
      current.assignment.assignment_xid !== initial.assignment.assignment_xid ||
      current.assignment.ready_at !== initial.assignment.ready_at ||
      (replay ? !isExactReady(current.assignment, receipt) : !isPending(current.assignment))
    )
      throw new Error();
    if (replay) {
      await admin.query("COMMIT");
      if (failed) throw new Error();
      return result("already_ready");
    }
    const ready = await admin.query<{ ready_xid: string }>(
      `UPDATE platform.hotel_setup_creation_scopes
       SET credential_role_oid=$2::oid,credential_secret_version=$3,credential_ready_at=pg_catalog.clock_timestamp()
       WHERE database_login=$1 AND organization_id=$4::uuid AND xmin=$5::xid
         AND credential_role_oid IS NULL AND credential_secret_version IS NULL AND credential_ready_at IS NULL
       RETURNING xmin::text AS ready_xid`,
      [
        receipt.login,
        receipt.expectedRoleOid,
        receipt.secretVersion,
        receipt.organizationId,
        initial.assignment.assignment_xid,
      ],
    );
    if (failed || ready.rowCount !== 1 || !ready.rows[0]?.ready_xid) throw new Error();
    readyXid = ready.rows[0].ready_xid;
    readyCommitAttempted = true;
    await admin.query("COMMIT");
    if (failed) throw new Error();
    return result("ready");
  } catch {
    await admin?.query("ROLLBACK").catch(() => undefined);
    await admin?.end().catch(() => undefined);
    admin = undefined;
    if (readyCommitAttempted && readyXid) {
      let inspection: pg.Client | undefined;
      let inspectionFailed = false;
      try {
        inspection = hotelSetupOrganizationConnection(adminDatabaseUrl, databaseEndpoint);
        inspection.on("error", () => {
          inspectionFailed = true;
        });
        await inspection.connect();
        await lockHotelSetupOfflineBootstrap(inspection);
        await inspection.query("BEGIN");
        const inspected = await lockApprovedIdentity(inspection, receipt);
        if (
          !isExactReady(inspected.assignment, receipt) ||
          inspected.assignment.assignment_xid !== readyXid ||
          inspectionFailed
        )
          throw new Error();
        await inspection.query("ROLLBACK");
        await proveFresh();
        await assertCurrentCredential();
        await inspection.query("BEGIN");
        const current = await lockApprovedIdentity(inspection, receipt);
        if (
          !isExactReady(current.assignment, receipt) ||
          current.assignment.assignment_xid !== readyXid ||
          inspectionFailed
        )
          throw new Error();
        await inspection.query("ROLLBACK");
        if (inspectionFailed) throw new Error();
        return result("ready_commit_inspected");
      } catch {
        await inspection?.query("ROLLBACK").catch(() => undefined);
      } finally {
        await inspection?.end().catch(() => undefined);
      }
    }
    throw new Error("Approved hotel setup readiness backfill requires recovery inspection");
  } finally {
    await admin?.end().catch(() => undefined);
    secrets?.destroy();
    sts?.destroy();
  }
}
