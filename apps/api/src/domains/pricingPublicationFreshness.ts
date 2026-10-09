import { createHash } from "node:crypto";
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

/** One log line per run. `problems` (stale plus unreadable publications) is what the alert
 * acts on; a lock timeout usually clears on the next run, so it is only counted. */
export function summarizePricingPublicationFreshness(report: PricingPublicationFreshness[]) {
  const stale = report.filter(
    (row): row is Extract<PricingPublicationFreshness, { stale: unknown }> =>
      "stale" in row && row.stale.length > 0,
  );
  const unreadable = report.filter((row) => "error" in row && row.error === "unreadable");
  return {
    checked: report.length,
    stale: stale.length,
    unreadable: unreadable.length,
    lockTimeouts: report.filter((row) => "error" in row && row.error === "lock_timeout").length,
    problems: stale.length + unreadable.length,
    staleProperties: stale.slice(0, 20),
    unreadableProperties: unreadable.slice(0, 20),
  };
}

export type PricingPublicationFreshnessSummary = ReturnType<
  typeof summarizePricingPublicationFreshness
>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Emails one recipient at most once a day while `problems` > 0. The idempotency key covers the
 * UTC day and the exact text, so another API task or a restart on the same day with the same
 * findings is deduplicated by the email provider. A failed send is retried on the next run. */
export function createPricingPublicationFreshnessAlert(options: {
  to: string;
  delivery: {
    send(input: {
      to: string;
      subject: string;
      text: string;
      idempotencyKey: string;
    }): Promise<void>;
  };
  now?: () => Date;
}) {
  let lastSentAt: number | undefined;
  return async (summary: PricingPublicationFreshnessSummary): Promise<boolean> => {
    const now = options.now?.() ?? new Date();
    if (summary.problems === 0) return false;
    if (lastSentAt !== undefined && now.getTime() - lastSentAt < DAY_MS) return false;
    const day = now.toISOString().slice(0, 10);
    const lines = [
      `The hourly pricing check on ${day} found ${summary.problems} published price list(s) that need attention.`,
      'Guests cannot see offers or book online at these hotels until someone opens PMS > Pricing and presses "Save prices".',
      "",
      ...(summary.stale > 0 ? ["Stale (property id: changed sources):"] : []),
      ...summary.staleProperties.map((row) => `- ${row.propertyId}: ${row.stale.join(", ")}`),
      ...(summary.unreadable > 0 ? ["Unreadable (property id):"] : []),
      ...summary.unreadableProperties.map((row) => `- ${row.propertyId}`),
      ...(summary.stale > summary.staleProperties.length ||
      summary.unreadable > summary.unreadableProperties.length
        ? ['More are listed in the next-api log line "Pricing publication freshness check".']
        : []),
      "",
      "This email is sent at most once a day while the problem lasts.",
    ];
    const text = lines.join("\n");
    await options.delivery.send({
      to: options.to,
      subject: `Vayada: ${summary.problems} published price list(s) need "Save prices"`,
      text,
      idempotencyKey: `pricing-publication-freshness:${day}:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`,
    });
    lastSentAt = now.getTime();
    return true;
  };
}
