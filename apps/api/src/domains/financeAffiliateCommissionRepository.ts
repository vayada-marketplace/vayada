import type { FinanceAffiliateCommissionRepository } from "@vayada/domain-finance";
import pg from "pg";

import { activeBookingPlanEntitlementSql } from "./propertyPlanReadModel.js";

export function createPgFinanceAffiliateCommissionRepository(config: {
  connectionString: string;
  max?: number;
  pool?: Pick<pg.Pool, "query" | "end">;
}): FinanceAffiliateCommissionRepository {
  if (!config.connectionString.trim()) throw new Error("Finance database URL is required");
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async getBookingFinanceAccess(propertyId, organizationId) {
      const result = await pool.query<{ active: boolean; exists: boolean }>(
        `SELECT
           EXISTS (
             SELECT 1 FROM finance.billing_entitlements entitlement
             WHERE entitlement.property_id = $1::uuid
               AND entitlement.organization_id = $2::uuid
               AND ${activeBookingPlanEntitlementSql("entitlement")}
           ) AS active,
           EXISTS (
             SELECT 1 FROM finance.billing_entitlements entitlement
             WHERE entitlement.property_id = $1::uuid
               AND entitlement.organization_id = $2::uuid
               AND entitlement.product = 'booking'
               AND entitlement.entitlement_key = 'direct-booking-finance'
           ) AS exists`,
        [propertyId, organizationId],
      );
      return result.rows[0]?.active ? "active" : result.rows[0]?.exists ? "inactive" : "missing";
    },

    async close() {
      await pool.end();
    },
  };
}
