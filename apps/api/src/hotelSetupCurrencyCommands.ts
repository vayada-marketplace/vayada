import type { PmsPricingCommandPort, PmsPricingCurrencyChangeGuardPort } from "@vayada/domain-pms";
import type pg from "pg";

import { createPgPmsPricingCommandRepository } from "./domains/pmsPricingCommandRepository.js";
import type { ProviderCredentialVault } from "./platform/providerCredentialVault.js";

type Options = {
  assignments: Pick<pg.Pool, "query">;
  vault: Pick<ProviderCredentialVault, "get">;
  databaseEndpoint: string;
  secretPrefix: string;
  currencyChangeGuard: PmsPricingCurrencyChangeGuardPort;
};

/** Private service only. The registry selects the login; secrets supply its password. */
export function createHotelSetupCurrencyCommands(
  options: Options,
): Pick<PmsPricingCommandPort, "upsertPropertyPricingCurrency"> {
  const endpoint = new URL(options.databaseEndpoint);
  if (
    !["postgres:", "postgresql:"].includes(endpoint.protocol) ||
    !endpoint.hostname ||
    endpoint.pathname.length < 2 ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !/^[A-Za-z0-9/_+=.@-]{1,256}\/$/.test(options.secretPrefix)
  )
    throw new Error("Invalid hotel setup credential configuration");
  const secretPrefix = options.secretPrefix;

  return {
    async upsertPropertyPricingCurrency(command) {
      try {
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
             AND scope.organization_id=$2::uuid AND scope.operation_class='currency_ready'
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
          [command.propertyId, command.organizationId],
        );
        const scope = result.rows.length === 1 ? result.rows[0] : undefined;
        if (
          !scope ||
          scope.propertyId !== command.propertyId ||
          scope.organizationId !== command.organizationId ||
          scope.operation !== "currency_ready" ||
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
        // ponytail: one pool per command avoids stale credential caches; reuse only if measured necessary.
        const repository = createPgPmsPricingCommandRepository({
          connectionString: connection.toString(),
          max: 1,
          hotelSetupCurrencyOperation: "currency_ready",
          currencyChangeGuard: options.currencyChangeGuard,
        });
        try {
          return await repository.upsertPropertyPricingCurrency(command);
        } finally {
          await repository.close();
        }
      } catch {
        throw new Error("Hotel setup currency command unavailable");
      }
    },
  };
}
