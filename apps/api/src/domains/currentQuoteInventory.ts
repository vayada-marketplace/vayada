import type { PoolClient } from "pg";
import { decodeCurrentPricingQuoteRecord } from "./currentPricingQuoteStore.js";
import { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import { reservePmsQuoteInventory } from "./pmsInventoryReservationLifecycleRepository.js";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";

/** Caller owns READ COMMITTED through booking acceptance and rolls back on failure.
 * A held inventory bundle is not an accepted booking. Accepted-command replay and
 * final expiry/cutoff checks after all owner waits belong to that future writer. */
export async function reserveCurrentQuoteInventory(
  client: PoolClient,
  slug: unknown,
  quoteId: unknown,
) {
  if (
    typeof quoteId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(quoteId)
  )
    throw new Error("Quote inventory is unavailable");
  const scope = await lockPublicPricingAuthority(client, slug);
  if (!scope) throw new Error("Quote inventory is unavailable");
  const row = (
    await client.query(
      "SELECT id,payload FROM booking.pricing_quotes WHERE id=$1 AND property_id=$2 AND organization_id=$3",
      [quoteId, scope.propertyId, scope.organizationId],
    )
  ).rows[0];
  const record = row
    ? decodeCurrentPricingQuoteRecord(row.payload, scope.propertyId, row.id)
    : null;
  if (!record) throw new Error("Quote inventory is unavailable");
  const { quote } = record;
  const reservation = await reservePmsQuoteInventory(
    client,
    {
      organizationId: scope.organizationId,
      propertyId: scope.propertyId,
      quoteId: quote.quoteId,
      checkIn: quote.stay.checkIn,
      checkOut: quote.stay.checkOut,
      rooms: quote.stay.rooms,
    },
    async () => {
      if (!(await lockCurrentQuoteRevalidation(client, slug, quote.quoteId)))
        throw new Error("Quote inventory is unavailable");
    },
  );
  if (!(await lockPublicPricingAuthority(client, slug)))
    throw new Error("Quote inventory is unavailable");
  return { quote, ...reservation };
}
