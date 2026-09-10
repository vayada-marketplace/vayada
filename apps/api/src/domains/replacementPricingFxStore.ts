import { pricingCurrencyScale, type PricingConversionRate } from "@vayada/domain-pms";
import type { Pool, PoolClient } from "pg";
import { createReplacementPricingFxReader, replacementPricingFxId, REPLACEMENT_FX_ATTRIBUTION } from "./replacementPricingFx.js";

/** Global reference-data port inside a caller-authorized publication transaction.
 * Immutable rows need no row lock. Check database WALL time again at publication;
 * an earlier successful read never extends an observation's validity. */
export async function lockReplacementPricingFxObservation(client: PoolClient, id: string, from: string, to: string): Promise<PricingConversionRate | null> {
  const fromScale = pricingCurrencyScale(from), toScale = pricingCurrencyScale(to);
  if (!/^exchange-rate-api:[a-f0-9]{64}$/.test(id) || from === to || fromScale === null || toScale === null) return null;
  const row = (await client.query(`SELECT id,from_currency,to_currency,numerator,denominator,observed_at,expires_at
    FROM finance.pricing_v2_fx_observations WHERE id=$1 AND provider=$2 AND from_currency=$3 AND to_currency=$4
      AND from_scale=$5 AND to_scale=$6 AND observed_at<=clock_timestamp() AND expires_at>clock_timestamp()`,
  [id, REPLACEMENT_FX_ATTRIBUTION.url, from, to, fromScale, toScale])).rows[0];
  if (!row) return null;
  const rate = { id: row.id, from: row.from_currency, to: row.to_currency, numerator: row.numerator, denominator: row.denominator,
    observedAt: (row.observed_at as Date).toISOString(), expiresAt: (row.expires_at as Date).toISOString() };
  return replacementPricingFxId(rate) === id ? rate : null;
}

/** Instantiate once per process. Only currency pairs cross this boundary; provider
 * transport/clock injection is trusted server/test wiring, never an HTTP payload. */
export function createReplacementPricingFxStore(pool: Pool, dependencies: Parameters<typeof createReplacementPricingFxReader>[0] = {}) {
  const reader = createReplacementPricingFxReader(dependencies);
  return {
    async observe(from: string, to: string): Promise<PricingConversionRate | null> {
      // Complete network work before acquiring a database connection or property lock.
      const rate = await reader.read(from, to);
      if (!rate) return null;
      const client = await pool.connect();
      try {
        await client.query(`INSERT INTO finance.pricing_v2_fx_observations
          (id,provider,from_currency,to_currency,numerator,denominator,from_scale,to_scale,observed_at,expires_at)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz
          WHERE $9::timestamptz<=clock_timestamp() AND $10::timestamptz>clock_timestamp()
          ON CONFLICT(id) DO NOTHING`, [rate.id, REPLACEMENT_FX_ATTRIBUTION.url, from, to, rate.numerator, rate.denominator,
          pricingCurrencyScale(from), pricingCurrencyScale(to), rate.observedAt, rate.expiresAt]);
        return await lockReplacementPricingFxObservation(client, rate.id, from, to);
      } finally { client.release(); }
    },
  };
}
