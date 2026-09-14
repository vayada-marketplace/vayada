import { createHash } from "node:crypto";
import { parsePublicPricingSelection, parseStoredPricingQuote } from "@vayada/domain-booking";
import { pricingKeys, pricingObject } from "@vayada/domain-pms";
import type { Pool } from "pg";
import { lockCurrentPricingQuote } from "./currentPricingQuote.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { PricingStorageError } from "./replacementPricingStore.js";
const fail = (code: PricingStorageError["code"]): never => {
  throw new PricingStorageError(code);
};
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_key, value) =>
    pricingObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
export function decodeCurrentPricingQuoteRecord(payload: unknown, propertyId: string, id: string) {
  if (
    !pricingObject(payload) ||
    !pricingKeys(payload, ["quote", "calculation"]) ||
    !pricingObject(payload.calculation) ||
    payload.calculation.version !== "booking.quote-calculation.v1"
  )
    return null;
  const quote = parseStoredPricingQuote(payload.quote);
  return quote && quote.quoteId === id && quote.stay.propertyId === propertyId
    ? { quote, calculation: structuredClone(payload.calculation) as Record<string, unknown> }
    : null;
}
/** Internal historical price records; no route, acceptance or inventory authority. */
export function createCurrentPricingQuoteStore(pool: Pool, lifetimeSeconds: number) {
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 900)
    return fail("invalid");
  return {
    async issue(slug: unknown, input: unknown) {
      if (
        !pricingObject(input) ||
        !pricingKeys(input, ["requestId", "selection", "paymentMethod"]) ||
        typeof input.requestId !== "string" ||
        !input.requestId.length ||
        input.requestId.length > 200 ||
        input.requestId !== input.requestId.trim() ||
        !["card", "pay_at_property"].includes(input.paymentMethod as string)
      )
        return fail("invalid");
      const selection = parsePublicPricingSelection(input.selection);
      if (!selection) return fail("invalid");
      const requestId = input.requestId,
        method = input.paymentMethod;
      const requestHash = createHash("sha256")
        .update(canonical({ selection, method }))
        .digest("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const scope = await lockPublicPricingAuthority(client, slug);
        if (!scope) return fail("denied");
        const prior = (
          await client.query(
            "SELECT id,organization_id,request_hash,payload FROM booking.pricing_quotes WHERE property_id=$1 AND request_id=$2",
            [scope.propertyId, requestId],
          )
        ).rows[0];
        if (prior) {
          if (prior.organization_id !== scope.organizationId) return fail("denied");
          if (prior.request_hash !== requestHash) return fail("idempotency_conflict");
          const record = decodeCurrentPricingQuoteRecord(prior.payload, scope.propertyId, prior.id);
          if (!record) return fail("invalid");
          if (!(await lockPublicPricingAuthority(client, slug))) return fail("denied");
          await client.query("COMMIT");
          return { ...record, replayed: true };
        }
        const record = await lockCurrentPricingQuote(
          client,
          slug,
          selection,
          method,
          lifetimeSeconds,
        );
        if (!record || record.quote.stay.propertyId !== scope.propertyId) return fail("denied");
        const inserted = await client.query(
          `INSERT INTO booking.pricing_quotes(id,property_id,organization_id,request_id,request_hash,payload)
          SELECT $1,$2,$3,$4,$5,$6 WHERE $7::timestamptz > clock_timestamp() RETURNING id`,
          [
            record.quote.quoteId,
            scope.propertyId,
            scope.organizationId,
            requestId,
            requestHash,
            record,
            record.quote.evidence.expiresAt,
          ],
        );
        if (!inserted.rowCount) return fail("stale");
        await client.query("COMMIT");
        return { ...record, replayed: false };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async read(slug: unknown, quoteId: unknown) {
      if (
        typeof quoteId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(quoteId)
      )
        return null;
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const scope = await lockPublicPricingAuthority(client, slug);
        if (!scope) return null;
        const row = (
          await client.query(
            "SELECT id,payload FROM booking.pricing_quotes WHERE id=$1 AND property_id=$2 AND organization_id=$3",
            [quoteId, scope.propertyId, scope.organizationId],
          )
        ).rows[0];
        if (!(await lockPublicPricingAuthority(client, slug))) return null;
        return row ? decodeCurrentPricingQuoteRecord(row.payload, scope.propertyId, row.id) : null;
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    },
  };
}
