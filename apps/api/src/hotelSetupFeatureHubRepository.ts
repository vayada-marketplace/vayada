import { randomUUID } from "node:crypto";
import { AuthorizationError } from "@vayada/backend-authorization";
import pg from "pg";
import { withHotelSetupCommandScope } from "./hotelSetupCommandScope.js";
import { lockHotelSetupCurrencyMembership } from "./hotelSetupCurrencyMembership.js";
import type { PmsModuleActivationRepository } from "./routes/pmsModuleActivations.js";

/** Private executor only; table grants and original-session verification are release gates. */
export function createPgHotelSetupFeatureHubRepository(config: {
  connectionString: string;
  pool?: Parameters<typeof withHotelSetupCommandScope>[0];
}): Pick<PmsModuleActivationRepository, "updateFinancials" | "close"> {
  if (!config.connectionString.trim()) throw new Error("Native setup database URL required");
  const ownedPool = config.pool
    ? null
    : new pg.Pool({ connectionString: config.connectionString, max: 1 });
  const pool = config.pool ?? ownedPool!;
  return {
    async updateFinancials(context, propertyId, isActive) {
      if (typeof isActive !== "boolean") throw new Error("Financials state must be boolean");
      return withHotelSetupCommandScope(
        pool,
        {
          propertyId,
          organizationId: context.selectedOrganization.organizationId,
          operation: "feature_hub",
        },
        async (client) => {
          const command = {
            propertyId,
            organizationId: context.selectedOrganization.organizationId,
            audit: {
              actor: { kind: "user" as const, userId: context.actor.internalUserId },
              requestId: context.audit.requestId,
              correlationId: context.audit.correlationId ?? null,
              requestedAt: context.audit.receivedAt,
            },
          };
          if (
            !(await lockHotelSetupCurrencyMembership(client, command, {
              permission: "pms.finance.manage",
              requireBaseAccess: isActive,
            }))
          )
            throw new AuthorizationError();
          await client.query(
            `INSERT INTO platform.product_audit_events
          (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,
           target_resource_product,target_resource_type,target_resource_id,correlation_id,
           redacted_payload,retention_class,privacy_scope)
          VALUES ($1,'pms',$2,pg_catalog.clock_timestamp(),'property',$3::uuid,'user',$4::uuid,
            'pms','pms_property',$3::uuid::text,$5,
            jsonb_build_object('moduleId','financials','isActive',$6::boolean),'financial','internal')`,
            [
              randomUUID(),
              isActive ? "financials_module_activated" : "financials_module_deactivated",
              propertyId,
              context.actor.internalUserId,
              context.audit.correlationId ?? context.audit.requestId,
              isActive,
            ],
          );
          const result = await client.query<{
            isActive: boolean;
            activatedAt: Date | null;
            deactivatedAt: Date | null;
            updatedAt: Date;
          }>(
            `SELECT status='active' AS "isActive",
          starts_at AS "activatedAt", CASE WHEN status='active' THEN NULL ELSE updated_at END AS "deactivatedAt",
          updated_at AS "updatedAt" FROM identity.product_entitlements
          WHERE organization_id=$1::uuid AND product='pms' AND entitlement_key='module:financials'
            AND resource_product='pms' AND resource_type='pms_property' AND lower(resource_id)=$2::uuid::text`,
            [command.organizationId, propertyId],
          );
          if (result.rows.length !== 1) throw new Error("Financials update unavailable");
          const row = result.rows[0]!;
          return {
            moduleId: "financials",
            isActive: row.isActive,
            activatedAt: row.activatedAt?.toISOString() ?? null,
            deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
            updatedAt: row.updatedAt.toISOString(),
          };
        },
      );
    },
    async close() {
      await ownedPool?.end();
    },
  };
}
