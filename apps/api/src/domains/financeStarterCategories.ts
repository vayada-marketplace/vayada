import type { QueryResultRow } from "pg";

/** Use the currency command's existing transaction. This does not activate Financials. */
export async function seedPendingHotelFinancialsCategories(
  client: {
    query<T extends QueryResultRow>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<{ rows: T[] }>;
  },
  scope: { propertyId: string; organizationId: string },
): Promise<void> {
  const pending = await client.query(
    `SELECT id FROM identity.product_entitlements
     WHERE organization_id=$1::uuid AND product='pms'
       AND entitlement_key='module:financials' AND status='suspended'
       AND resource_product='pms' AND resource_type='pms_property'
       AND resource_id=$2::uuid::text
       AND metadata->>'newHotelFinancialsDefault'='pending'`,
    [scope.organizationId, scope.propertyId],
  );
  if (pending.rows.length === 0) return;
  if (pending.rows.length !== 1) throw new Error("Ambiguous pending Financials setup");

  await client.query(
    `INSERT INTO finance.expense_categories
       (property_id, system_key, name, color, sort_order)
     SELECT $1::uuid, seed.system_key, seed.name, seed.color, seed.sort_order
     FROM (VALUES
       ('staff', 'Staff', '#6366F1', 10),
       ('ota_commission', 'OTA commission', '#F59E0B', 20),
       ('utilities', 'Utilities', '#06B6D4', 30),
       ('maintenance', 'Maintenance', '#EF4444', 40),
       ('supplies', 'Supplies', '#8B5CF6', 50),
       ('marketing', 'Marketing', '#EC4899', 60),
       ('platform_fees', 'Platform fees', '#64748B', 70)
     ) AS seed(system_key, name, color, sort_order)
     ON CONFLICT (property_id, system_key) WHERE system_key IS NOT NULL DO NOTHING`,
    [scope.propertyId],
  );
  const active = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM finance.expense_categories
     WHERE property_id=$1::uuid AND archived_at IS NULL
       AND system_key IN ('staff', 'ota_commission', 'utilities', 'maintenance',
                          'supplies', 'marketing', 'platform_fees')`,
    [scope.propertyId],
  );
  if (active.rows[0]?.count !== 7) throw new Error("Financials starter categories incomplete");
}
