import { isDeepStrictEqual } from "node:util";
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
  const stored = await loadScopedQuote(client, slug, quoteId);
  return reserveScopedQuote(client, slug, stored, async () => {
    if (!(await lockCurrentQuoteRevalidation(client, slug, stored.quote.quoteId)))
      throw new Error("Quote inventory is unavailable");
  });
}

type RevalidatedQuote = NonNullable<Awaited<ReturnType<typeof lockCurrentQuoteRevalidation>>>;

/** Internal composition path: current MUST come from lockCurrentQuoteRevalidation
 * on this exact client/READ COMMITTED transaction before inventory/promo mutations,
 * with every owner lock retained. It is not a posted request or proof transferable
 * between transactions. Reuses PMS replay, calendar, availability and mutation locks;
 * does not reprice after this command's own effects. Caller handles accepted-command
 * replay first, final clock/Finance checks after all waits, and full rollback. */
export async function reserveRevalidatedQuoteInventory(
  client: PoolClient,
  slug: unknown,
  current: RevalidatedQuote,
) {
  const stored = await loadScopedQuote(client, slug, current.quote.quoteId);
  if (
    current.kind !== "current_quote_price" ||
    !isDeepStrictEqual(stored.scope, current.scope) ||
    !isDeepStrictEqual(stored.quote, current.quote)
  )
    throw new Error("Quote inventory is unavailable");
  return reserveScopedQuote(client, slug, stored, async () => {
    await requireSamePublicScope(client, slug, stored.scope);
  });
}

async function loadScopedQuote(client: PoolClient, slug: unknown, quoteId: unknown) {
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
  return { quote: record.quote, scope };
}

async function requireSamePublicScope(
  client: PoolClient,
  slug: unknown,
  scope: NonNullable<Awaited<ReturnType<typeof lockPublicPricingAuthority>>>,
) {
  if (!isDeepStrictEqual(await lockPublicPricingAuthority(client, slug), scope))
    throw new Error("Quote inventory is unavailable");
}

async function reserveScopedQuote(
  client: PoolClient,
  slug: unknown,
  stored: Awaited<ReturnType<typeof loadScopedQuote>>,
  requireLockedQuote: () => Promise<void>,
) {
  const { quote, scope } = stored;
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
    requireLockedQuote,
  );
  await requireSamePublicScope(client, slug, scope);
  return { quote, ...reservation };
}
