import { readFile, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { STSClient } from "@aws-sdk/client-sts";
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import pg from "pg";
import { vi } from "vitest";
import { reconcileHotelSetupAutomaticScopes } from "./hotelSetupAutomaticReconciliation.js";
import { createHotelSetupCreationCommands } from "./hotelSetupCreationCommands.js";
import { createHotelSetupNativeSecretReader } from "./hotelSetupNativeSecretReader.js";
import { createPgSharedHotelSetupStatusRepository } from "./platform/sharedHotelSetupStatusReadModel.js";
import type { checkHotelSetupCreationCredential } from "./cli/hotelSetupCreationPreflight.js";
import type { checkHotelSetupPropertyCredential } from "./cli/hotelSetupPropertyPreflight.js";
import { hotelSetupOrganizationRolePrefix } from "./hotelSetupOrganizationRoleStaging.js";

/** Owned TLS database only; AWS is fully stubbed, while both native DB proofs execute. */
export async function createAutomaticOwnerFlowFixture(databaseUrl: string, rollbackRoot: string) {
  const url = new URL(databaseUrl);
  if (
    url.hostname !== "127.0.0.1" ||
    !url.pathname.startsWith("/vay1092_automatic_owner_flow_test") ||
    url.search !== "?sslmode=verify-full" ||
    !isAbsolute(rollbackRoot)
  )
    throw new Error("Owned TLS database and separately compiled local rollback root required");
  const secondaryRoot = await realpath(rollbackRoot);
  if (secondaryRoot === (await realpath(new URL("../../../", import.meta.url))))
    throw new Error("A distinct compiled rollback checkout is required");
  const secondaryCreation: {
    checkHotelSetupCreationCredential: typeof checkHotelSetupCreationCredential;
  } = await import(
    pathToFileURL(`${secondaryRoot}/apps/api/dist/cli/hotelSetupCreationPreflight.js`).href
  );
  const secondaryProperty: {
    checkHotelSetupPropertyCredential: typeof checkHotelSetupPropertyCredential;
  } = await import(
    pathToFileURL(`${secondaryRoot}/apps/api/dist/cli/hotelSetupPropertyPreflight.js`).href
  );
  const endpoint = new URL(url);
  endpoint.username = endpoint.password = endpoint.search = "";
  const admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  const repository = createPgSharedHotelSetupStatusRepository({
    connectionString: url.toString(),
    max: 1,
  });
  const organizationId = randomUUID(),
    actorUserId = randomUUID(),
    membershipId = randomUUID();
  const databases = (
    await admin.query<{ name: string; privileges: string[] }>(`SELECT d.datname AS name,
      COALESCE(array_agg(a.privilege_type) FILTER(WHERE a.grantee=0),ARRAY[]::text[]) AS privileges
      FROM pg_database d LEFT JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a ON true
      WHERE d.datallowconn GROUP BY d.datname`)
  ).rows;
  const records = new Map<
    string,
    { Name: string; VersionId: string; ARN: string; SecretString: string }
  >();
  vi.stubEnv("AWS_ACCESS_KEY_ID", "synthetic-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-secret");
  vi.stubEnv("AWS_PROFILE", undefined);
  vi.spyOn(STSClient.prototype, "send").mockResolvedValue({ Account: "269416271598" } as never);
  const send = async (command: unknown) => {
    if (command instanceof DescribeSecretCommand) {
      if (records.has(command.input.SecretId!))
        throw new Error("Existing secret must never be overwritten");
      throw Object.assign(new Error(), { name: "ResourceNotFoundException" });
    }
    if (command instanceof CreateSecretCommand) {
      const Name = command.input.Name!,
        VersionId = command.input.ClientRequestToken!;
      if (records.has(Name)) throw new Error("Duplicate secret");
      const record = {
        Name,
        VersionId,
        ARN: `arn:aws:secretsmanager:eu-west-1:269416271598:secret:${Name}-123abc`,
        SecretString: command.input.SecretString!,
      };
      records.set(Name, record);
      return record;
    }
    if (!(command instanceof GetSecretValueCommand)) throw new Error("Unexpected AWS command");
    const record = [...records.values()].find(
      (r) => r.Name === command.input.SecretId || r.ARN === command.input.SecretId,
    );
    if (!record || record.VersionId !== command.input.VersionId)
      throw new Error("Unpinned or unknown native secret");
    return record;
  };
  const aws = vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation(send as never);
  const options = {
    assignments: admin,
    readNativeSecret: createHotelSetupNativeSecretReader(),
    databaseEndpoint: endpoint.toString(),
    secretPrefix: "hotel-setup-command/prod/property/",
  };
  const creation = createHotelSetupCreationCommands({
    ...options,
    secretPrefix: "hotel-setup-command/prod/organization/",
  });
  const proveOrganization = vi.fn(secondaryCreation.checkHotelSetupCreationCredential);
  const proveProperty = vi.fn(secondaryProperty.checkHotelSetupPropertyCredential);
  const pass = (mode: "organization" | "property") =>
    reconcileHotelSetupAutomaticScopes({
      mode,
      adminDatabaseUrl: url.toString(),
      databaseEndpoint: endpoint.toString(),
      proveOrganization,
      proveProperty,
    });
  const close = async () => {
    try {
      await repository.close?.();
      const properties = (
        await admin.query<{ id: string }>(
          "SELECT id FROM hotel_catalog.properties WHERE creation_organization_id=$1",
          [organizationId],
        )
      ).rows;
      const prefixes = [
        hotelSetupOrganizationRolePrefix(organizationId),
        ...properties.flatMap(({ id }) =>
          ["launch_settings", "currency_ready", "feature_hub"].map(
            (purpose) =>
              `vayada_next_hotel_setup_property_${createHash("sha256").update(`${id}:${purpose}`).digest("hex").slice(0, 16)}_`,
          ),
        ),
      ];
      const roles = (
        await admin.query<{ rolname: string }>("SELECT rolname FROM pg_roles")
      ).rows.filter((r) => prefixes.some((prefix) => r.rolname.startsWith(prefix)));
      for (const { rolname } of roles) {
        await admin.query(`DROP OWNED BY ${admin.escapeIdentifier(rolname)}`);
        await admin.query(`DROP ROLE ${admin.escapeIdentifier(rolname)}`);
      }
    } finally {
      try {
        for (const database of databases)
          if (database.privileges.length)
            await admin.query(
              `GRANT ${database.privileges.join(",")} ON DATABASE ${admin.escapeIdentifier(database.name)} TO PUBLIC`,
            );
      } finally {
        await admin.end();
      }
    }
  };
  try {
    for (const database of databases)
      await admin.query(
        `REVOKE ALL ON DATABASE ${admin.escapeIdentifier(database.name)} FROM PUBLIC`,
      );
    const cursor = await admin.query(
      "SELECT to_regclass('platform.hotel_setup_reconciliation_cursors') AS name",
    );
    if (!cursor.rows[0]?.name)
      await admin.query(
        await readFile(
          new URL(
            "../../../packages/backend-migration/migrations/0464_hotel_setup_reconciliation_cursor.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
    await admin.query(
      "UPDATE platform.hotel_setup_reconciliation_cursors SET scope_id=NULL,organization_id=NULL,actor_user_id=NULL",
    );
    // This new disposable database has no real accounts. Disable prior fixture candidates only.
    await admin.query("UPDATE identity.organization_memberships SET status='inactive'");
    await admin.query(
      "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Synthetic Owner group',$1::uuid::text)",
      [organizationId],
    );
    await admin.query(
      "INSERT INTO identity.users(id,email) VALUES($1,$1::uuid::text || '@fixture.invalid')",
      [actorUserId],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
        (id,organization_id,user_id,role_key,property_access_mode,access_origin,pms_access_enabled,booking_access_enabled)
        VALUES($1,$2,$3,'hotel_owner','all','agency',true,true)`,
      [membershipId, organizationId, actorUserId],
    );
    await admin.query(
      "INSERT INTO hotel_catalog.organization_setup_track_intents(organization_id,selected_tracks) VALUES($1,ARRAY['hotel_operations','creator_marketplace'])",
      [organizationId],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements(organization_id,product,entitlement_key) VALUES
        ($1,'pms','property-management'),($1,'booking','booking-engine'),($1,'marketplace','marketplace-hotel-profile')`,
      [organizationId],
    );
  } catch (error) {
    await close();
    throw error;
  }
  return {
    admin,
    repository,
    organizationId,
    actorUserId,
    membershipId,
    aws,
    options,
    creation,
    proveOrganization,
    proveProperty,
    records,
    pass,
    close,
  };
}
