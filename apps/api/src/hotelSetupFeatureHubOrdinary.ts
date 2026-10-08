import { randomUUID } from "node:crypto";
import { AuthorizationError } from "@vayada/backend-authorization";
import { lockHotelSetupCurrencyMembership } from "./hotelSetupCurrencyMembership.js";
import {
  BASE_ENTITLEMENTS,
  FIRST_CURRENCIES,
} from "./domains/hotelSetupFirstCurrencyCompletion.js";
import {
  withOrdinaryHotelSetupPropertyScope,
  type HotelSetupPropertyScopeRunner,
} from "./hotelSetupOrdinaryScope.js";
import type { PmsModuleActivationRepository } from "./routes/pmsModuleActivations.js";

type ScopePool = Parameters<HotelSetupPropertyScopeRunner>[0];

/** The native receipt (0449) uses newHotelFinancialsOwnerDisabled, which its guard trigger strips
 * from every non-native write, so any later write by anyone cancels it. The ordinary login cannot
 * write that key; it records Owner-off as the switch-off transaction id, which only counts while
 * it equals the row's xmin: any later write to the row by anyone cancels it the same way. */
const OWNER_OFF = "featureHubOwnerDisabled";

export class HotelSetupFinancialsUnavailableError extends Error {
  readonly code = "23514";
}

/** Ordinary-login port of the native Feature Hub command (VAY-2056): the trigger
 * platform.apply_hotel_setup_feature_hub_command (0449) only fires for native logins. Same
 * scope locks and Owner re-check (pms.finance.manage, base access when enabling), the same
 * activation prerequisites, and an Owner may re-enable only Financials that an Owner switched
 * off, never a row suspended by anyone else. */
export function createOrdinaryHotelSetupFeatureHubCommands(
  pool: ScopePool,
): Pick<PmsModuleActivationRepository, "updateFinancials"> {
  return {
    async updateFinancials(context, propertyId, isActive) {
      if (typeof isActive !== "boolean") throw new Error("Financials state must be boolean");
      if (!context.actor.providerIdentity.sessionId) throw new AuthorizationError();
      const organizationId = context.selectedOrganization.organizationId;
      return withOrdinaryHotelSetupPropertyScope(
        pool,
        { propertyId, organizationId },
        async (client) => {
          const command = {
            propertyId,
            organizationId,
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
          const rows = await client.query<{
            id: string;
            status: string;
            ready: boolean;
            ownerOff: boolean;
            window: boolean;
          }>(
            `SELECT id::text, status,
             metadata->>'newHotelFinancialsDefault'='ready'
               AND metadata ? 'newHotelFinancialsActivationTransaction' AS ready,
             COALESCE(metadata->>'${OWNER_OFF}' = xmin::text, FALSE)
               OR COALESCE(metadata->'newHotelFinancialsOwnerDisabled'='true'::jsonb, FALSE) AS "ownerOff",
             (starts_at IS NULL OR starts_at<=clock_timestamp())
               AND (expires_at IS NULL OR expires_at>clock_timestamp()) AS window
           FROM identity.product_entitlements
           WHERE organization_id=$1::uuid AND product='pms' AND entitlement_key='module:financials'
             AND resource_product='pms' AND resource_type='pms_property' AND lower(resource_id)=$2::uuid::text
           FOR UPDATE`,
            [organizationId, propertyId],
          );
          if (rows.rows.length !== 1)
            throw new HotelSetupFinancialsUnavailableError(
              "Hotel setup Financials activation unavailable",
            );
          const entitlement = rows.rows[0]!;
          // Only a completed new-hotel default is the Owner's to toggle, in either direction.
          if (!entitlement.ready)
            throw new HotelSetupFinancialsUnavailableError(
              "Hotel setup Financials activation unavailable",
            );
          await client.query(
            `SELECT id FROM identity.product_entitlements WHERE organization_id=$1::uuid AND product='pms'
             AND entitlement_key = ANY(array_append($3::text[], 'module:financials'))
             AND (resource_product IS NULL OR (resource_product='pms' AND resource_type='pms_property'
               AND lower(resource_id)=$2::uuid::text)) FOR SHARE`,
            [organizationId, propertyId, BASE_ENTITLEMENTS],
          );
          await client.query(
            "SELECT property_id FROM pms.property_pricing_settings WHERE property_id=$1::uuid FOR SHARE",
            [propertyId],
          );
          if (isActive) {
            const prerequisites = await client.query<{ ok: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM pms.property_pricing_settings
                 WHERE property_id=$2::uuid AND currency::text = ANY($5::text[]))
               AND NOT EXISTS (SELECT 1 FROM identity.product_entitlements
                 WHERE organization_id=$1::uuid AND product='pms' AND id<>$3::uuid
                   AND entitlement_key = ANY(array_append($4::text[], 'module:financials'))
                   AND status='suspended' AND (starts_at IS NULL OR starts_at<=clock_timestamp())
                   AND (expires_at IS NULL OR expires_at>clock_timestamp())
                   AND (resource_product IS NULL OR (resource_product='pms' AND resource_type='pms_property'
                     AND lower(resource_id)=$2::uuid::text)))
               AND EXISTS (SELECT 1 FROM identity.product_entitlements
                 WHERE organization_id=$1::uuid AND product='pms' AND entitlement_key = ANY($4::text[])
                   AND status='active' AND (starts_at IS NULL OR starts_at<=clock_timestamp())
                   AND (expires_at IS NULL OR expires_at>clock_timestamp())
                   AND (resource_product IS NULL OR (resource_product='pms' AND resource_type='pms_property'
                     AND lower(resource_id)=$2::uuid::text))) AS ok`,
              [organizationId, propertyId, entitlement.id, BASE_ENTITLEMENTS, FIRST_CURRENCIES],
            );
            if (
              !entitlement.window ||
              (entitlement.status !== "active" &&
                (entitlement.status !== "suspended" || !entitlement.ownerOff)) ||
              prerequisites.rows[0]?.ok !== true
            )
              throw new HotelSetupFinancialsUnavailableError(
                "Hotel setup Financials activation unavailable",
              );
          }
          const ownerOff = !isActive && (entitlement.status === "active" || entitlement.ownerOff);
          await client.query(
            `UPDATE identity.product_entitlements SET status=$2, updated_at=clock_timestamp(),
             metadata=metadata || jsonb_build_object('${OWNER_OFF}',
               CASE WHEN $3::boolean THEN to_jsonb(pg_current_xact_id()::xid::text) ELSE 'false'::jsonb END)
           WHERE id=$1::uuid`,
            [entitlement.id, isActive ? "active" : "suspended", ownerOff],
          );
          await client.query(
            `INSERT INTO platform.product_audit_events
           (audit_key,product,action,occurred_at,tenant_scope,property_id,actor_type,actor_user_id,
            target_resource_product,target_resource_type,target_resource_id,correlation_id,
            redacted_payload,audit_metadata,retention_class,privacy_scope)
           VALUES ($1,'pms',$2,clock_timestamp(),'property',$3::uuid,'user',$4::uuid,
             'pms','pms_property',$3::uuid::text,$5,
             jsonb_build_object('moduleId','financials','isActive',$6::boolean),
             jsonb_build_object('actorOrganizationId',$7::uuid::text,
               'hotelSetupTransaction',pg_current_xact_id()::text),'financial','internal')`,
            [
              randomUUID(),
              isActive ? "financials_module_activated" : "financials_module_deactivated",
              propertyId,
              context.actor.internalUserId,
              context.audit.correlationId ?? context.audit.requestId,
              isActive,
              organizationId,
            ],
          );
          const result = await client.query<{
            isActive: boolean;
            activatedAt: Date | null;
            updatedAt: Date;
          }>(
            `SELECT status='active' AS "isActive", starts_at AS "activatedAt", updated_at AS "updatedAt"
           FROM identity.product_entitlements WHERE id=$1::uuid`,
            [entitlement.id],
          );
          const row = result.rows[0]!;
          return {
            moduleId: "financials",
            isActive: row.isActive,
            activatedAt: row.activatedAt?.toISOString() ?? null,
            deactivatedAt: row.isActive ? null : row.updatedAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          };
        },
      );
    },
  };
}
