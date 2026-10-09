import type { Pool } from "pg";
import { lockBookingPricingTermsSource } from "./bookingPricingOfferTerms.js";
import { lockFinanceReplacementPricingSource } from "./financeReplacementPricingSource.js";
import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";
import { lockPmsReplacementPricingRoomSource } from "./pmsReplacementPricingRoomSource.js";
import { readCurrentPricingSnapshot } from "./replacementPricingSnapshot.js";

const SOURCES = ["room", "terms", "finance"] as const;
export type PricingPublicationFreshness =
  | { propertyId: string; revision: number; stale: (typeof SOURCES)[number][] }
  | { propertyId: string; error: "unreadable" | "lock_timeout" };

/** Monitoring report (VAY-2088): for each property with a published pricing-v2 head, the
 * recorded source tokens that no longer match. Public offers and quotes are unavailable
 * for a stale publication until it is published again. Each property is read in its own
 * transaction that is always rolled back; the owner reads take the publication reader's
 * row locks in its order (inventory, rooms, terms, Finance), bounded by lock_timeout. */
export async function readPricingPublicationFreshness(
  pool: Pool,
  propertyId?: string,
): Promise<PricingPublicationFreshness[]> {
  const heads = (
    await pool.query(
      `SELECT property_id::text AS id FROM pms.pricing_v2_heads
      WHERE revision>0 AND ($1::uuid IS NULL OR property_id=$1::uuid) ORDER BY property_id`,
      [propertyId ?? null],
    )
  ).rows as { id: string }[];
  const report: PricingPublicationFreshness[] = [];
  for (const { id } of heads) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await lockPmsInventoryMutationScope(client, id);
      const stored = await readCurrentPricingSnapshot(client, id);
      if (!stored) {
        report.push({ propertyId: id, error: "unreadable" });
        continue;
      }
      const current = {
        room: await lockPmsReplacementPricingRoomSource(client, id),
        terms: await lockBookingPricingTermsSource(client, id),
        finance: await lockFinanceReplacementPricingSource(client, id),
      };
      report.push({
        propertyId: id,
        revision: stored.revision,
        stale: SOURCES.filter((key) => stored.sources[key] !== current[key]),
      });
    } catch (error) {
      if ((error as { code?: unknown }).code !== "55P03") throw error;
      report.push({ propertyId: id, error: "lock_timeout" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
  return report;
}
