import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { parseAddonEconomicTerms, type AddonEconomicTerms } from "@vayada/domain-booking";
import { pricingCurrencyScale, pricingObject } from "@vayada/domain-pms";
import { pricingDecimalMinor } from "./pricingDecimalMinor.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";

const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const models = ["per_stay", "per_night", "per_guest", "per_guest_night"] as const;
type Addon = AddonEconomicTerms & {
  id: string;
  name: string;
  amountMinor: string;
  currency: string;
  pricingModel: (typeof models)[number];
  maxQuantity: number;
  maxGuests: number | null;
  leadTime: string | null;
};
const limit = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 2147483647;

/** Current Booking definitions inside an already authorized READ COMMITTED transaction.
 * Returns unit prices and owner rules only: no selected-person/date eligibility,
 * FX, partner payout calculation, add-on total or permission to accept a quote. */
export async function lockReplacementAddons(
  client: PoolClient,
  input: { propertyId: string; currency: string; addonIds: readonly string[] },
): Promise<{ addons: Addon[]; sourceRevision: string } | null> {
  if (
    !input ||
    !uuid(input.propertyId) ||
    !Array.isArray(input.addonIds) ||
    input.addonIds.length > 99 ||
    input.addonIds.some((id) => !uuid(id))
  )
    return null;
  const scale = pricingCurrencyScale(input.currency);
  if (scale === null) return null;
  const propertyId = input.propertyId.toLowerCase(),
    currency = input.currency;
  const ids = input.addonIds.map((id) => id.toLowerCase()).sort();
  if (new Set(ids).size !== ids.length) return null;
  await lockPmsInventoryMutationScope(client, propertyId);
  // Parent lock blocks FK-backed insertion/retargeting; row locks block edits/deletion.
  if (
    !(
      await client.query("SELECT id FROM hotel_catalog.properties WHERE id=$1 FOR UPDATE", [
        propertyId,
      ])
    ).rowCount
  )
    return null;
  const rows = (
    await client.query(
      `SELECT a.*, price_amount::text AS amount,
     partner_commission_rate::text AS commission,
     (to_jsonb(a)-'created_at'-'updated_at')::text AS source
     FROM booking.addon_definitions a WHERE property_id=$1 ORDER BY id FOR SHARE`,
      [propertyId],
    )
  ).rows;
  const addons: Addon[] = [];
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (
      !row ||
      row.status !== "active" ||
      row.public_visible !== true ||
      row.currency !== currency ||
      !models.includes(row.pricing_model) ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      !pricingObject(row.metadata)
    )
      return null;
    const amountMinor = pricingDecimalMinor(row.amount, scale);
    const terms = parseAddonEconomicTerms({
      ownershipKind: row.ownership_kind,
      partnerCommissionRate: row.commission,
    });
    const maxQuantity = row.metadata.maxQuantity === undefined ? 1 : row.metadata.maxQuantity;
    const maxGuests = row.metadata.maxGuests === undefined ? null : row.metadata.maxGuests;
    const leadTime = row.metadata.leadTime === undefined ? null : row.metadata.leadTime;
    if (
      amountMinor === null ||
      !terms ||
      !limit(maxQuantity) ||
      (maxGuests !== null && !limit(maxGuests)) ||
      (leadTime !== null && typeof leadTime !== "string")
    )
      return null;
    addons.push({
      id,
      name: row.name,
      amountMinor,
      currency,
      pricingModel: row.pricing_model,
      maxQuantity,
      maxGuests,
      leadTime,
      ...terms,
    });
  }
  return {
    addons,
    sourceRevision:
      "booking.addons.v2:" +
      createHash("sha256")
        .update(JSON.stringify({ propertyId, currency, rows: rows.map((r) => r.source) }))
        .digest("hex"),
  };
}
