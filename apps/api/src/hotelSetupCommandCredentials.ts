import type pg from "pg";
import type { ProviderCredentialVault } from "./platform/providerCredentialVault.js";

export type HotelSetupCredentialOptions = {
  assignments: Pick<pg.Pool, "query">;
  vault: Pick<ProviderCredentialVault, "get">;
  databaseEndpoint: string;
  secretPrefix: string;
};

export function parseHotelSetupCredentialConfiguration(
  options: Pick<HotelSetupCredentialOptions, "databaseEndpoint" | "secretPrefix">,
): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(options.databaseEndpoint);
  } catch {
    throw new Error("Invalid hotel setup credential configuration");
  }
  if (
    !["postgres:", "postgresql:"].includes(endpoint.protocol) ||
    !endpoint.hostname ||
    endpoint.pathname.length < 2 ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !/^[A-Za-z0-9/_+=.@-]{1,256}\/$/.test(options.secretPrefix) ||
    options.secretPrefix.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new Error("Invalid hotel setup credential configuration");
  return endpoint;
}

/** Private service only. Purpose comes from the adapter, never the HTTP caller. */
export function createHotelSetupCredentialResolver(
  options: HotelSetupCredentialOptions,
  operation: "currency_ready" | "feature_hub",
) {
  if (operation !== "currency_ready" && operation !== "feature_hub")
    throw new Error("Invalid hotel setup credential purpose");
  const endpoint = parseHotelSetupCredentialConfiguration(options);
  const secretPrefix = options.secretPrefix;

  return async (propertyId: string, organizationId: string): Promise<string> => {
    const result = await options.assignments.query<{
      databaseLogin: string;
      propertyId: string;
      organizationId: string;
      operation: string;
    }>(
      `SELECT scope.database_login::text AS "databaseLogin",
            scope.property_id::text AS "propertyId",
            scope.organization_id::text AS "organizationId",
            scope.operation_class AS operation
           FROM platform.hotel_setup_property_scopes scope
           JOIN identity.organizations organization ON organization.id=scope.organization_id
           WHERE scope.active AND scope.property_id=$1::uuid
             AND scope.organization_id=$2::uuid AND scope.operation_class=$3
             AND organization.kind='hotel_group' AND organization.status='active'
             AND EXISTS (SELECT 1 FROM identity.organization_resource_links link
               WHERE link.organization_id=scope.organization_id
                 AND link.product='hotel_catalog' AND link.resource_type='property'
                 AND lower(link.resource_id)=$1::uuid::text
                 AND link.relationship='owner' AND link.status='active')
             AND EXISTS (SELECT 1 FROM identity.organization_resource_links link
               WHERE link.organization_id=scope.organization_id
                 AND link.product='pms' AND link.resource_type='pms_property'
                 AND lower(link.resource_id)=$1::uuid::text
                 AND link.relationship='owner' AND link.status='active')`,
      [propertyId, organizationId, operation],
    );
    const scope = result.rows.length === 1 ? result.rows[0] : undefined;
    if (
      !scope ||
      scope.propertyId !== propertyId ||
      scope.organizationId !== organizationId ||
      scope.operation !== operation ||
      !/^vayada_next_hotel_setup_property_[a-z0-9_]+$/.test(scope.databaseLogin) ||
      Buffer.byteLength(scope.databaseLogin) > 63
    )
      throw new Error("Missing hotel setup assignment");

    const secret = await options.vault.get<unknown>(secretPrefix + scope.databaseLogin);
    if (
      typeof secret !== "object" ||
      secret === null ||
      Array.isArray(secret) ||
      Object.keys(secret).length !== 2 ||
      !("username" in secret) ||
      !("password" in secret) ||
      secret.username !== scope.databaseLogin ||
      typeof secret.password !== "string" ||
      Buffer.byteLength(secret.password) < 32
    )
      throw new Error("Invalid hotel setup credential");

    const connection = new URL(endpoint);
    connection.username = scope.databaseLogin;
    connection.password = encodeURIComponent(secret.password);
    connection.searchParams.set("sslmode", "verify-full");
    return connection.toString();
  };
}
