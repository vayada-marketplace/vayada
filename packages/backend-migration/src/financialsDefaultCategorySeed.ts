import type pg from "pg";

const DEFAULTS = [
  ["staff", "Staff", "#6366F1", 10],
  ["ota_commission", "OTA commission", "#F59E0B", 20],
  ["utilities", "Utilities", "#06B6D4", 30],
  ["maintenance", "Maintenance", "#EF4444", 40],
  ["supplies", "Supplies", "#8B5CF6", 50],
  ["marketing", "Marketing", "#EC4899", 60],
  ["platform_fees", "Platform fees", "#64748B", 70],
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function seedFinancialsDefaultCategories(
  client: pg.Client,
  input: { propertyId: string; apply: boolean },
) {
  if (!UUID.test(input.propertyId)) throw new Error("Invalid property ID");
  const propertyId = input.propertyId.toLowerCase();
  await client.query(input.apply ? "BEGIN" : "BEGIN READ ONLY");
  try {
    if (input.apply) await client.query("SET LOCAL lock_timeout='3s'");
    const eligible =
      (
        await client.query(
          `SELECT 1 FROM pms.property_pricing_settings WHERE property_id=$1::uuid ${input.apply ? "FOR UPDATE" : ""}`,
          [propertyId],
        )
      ).rowCount === 1;
    if (!eligible)
      throw new Error("Property has no PMS pricing settings; defaults were not seeded");

    const before = await categoryState(client, propertyId);
    const inserted = input.apply
      ? (
          await client.query<{ system_key: string }>(
            `INSERT INTO finance.expense_categories(property_id,system_key,name,color,sort_order)
             SELECT $1::uuid,seed.key,seed.name,seed.color,seed.sort_order
             FROM jsonb_to_recordset($2::jsonb) AS seed(key text,name text,color text,sort_order int)
             ON CONFLICT (property_id,system_key) WHERE system_key IS NOT NULL DO NOTHING
             RETURNING system_key`,
            [
              propertyId,
              JSON.stringify(
                DEFAULTS.map(([key, name, color, sort_order]) => ({
                  key,
                  name,
                  color,
                  sort_order,
                })),
              ),
            ],
          )
        ).rows
          .map((row) => row.system_key)
          .sort()
      : [];
    const after = input.apply ? await categoryState(client, propertyId) : before;
    await client.query("COMMIT");
    return {
      propertyId,
      mode: input.apply ? ("apply" as const) : ("dry-run" as const),
      missingBefore: before.missing,
      archived: after.archived,
      inserted,
      missingAfter: after.missing,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function categoryState(client: pg.Client, propertyId: string) {
  const rows = (
    await client.query<{ system_key: string; archived_at: Date | null }>(
      `SELECT system_key,archived_at FROM finance.expense_categories
       WHERE property_id=$1::uuid AND system_key=ANY($2::text[])`,
      [propertyId, DEFAULTS.map(([key]) => key)],
    )
  ).rows;
  const byKey = new Map(rows.map((row) => [row.system_key, row.archived_at]));
  return {
    missing: DEFAULTS.map(([key]) => key).filter((key) => !byKey.has(key) || byKey.get(key)),
    archived: rows
      .filter((row) => row.archived_at)
      .map((row) => row.system_key)
      .sort(),
  };
}
