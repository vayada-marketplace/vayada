import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import { pricingObject } from "@vayada/domain-pms";
import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { replayPricingAcceptance } from "./pricingAcceptanceReplay.js";
import { lockCurrentQuoteRevalidation } from "./currentQuoteRevalidation.js";
import { lockCurrentQuoteGuestDisclosure } from "./currentQuoteGuestDisclosure.js";
import { lockFinancePricingAcceptanceTerms } from "./financePricingAcceptanceTerms.js";
import { parseBookingQuoteAcceptanceInput } from "./bookingQuoteAcceptanceInput.js";
import { pricingRoomRevenueProjection } from "./pricingRoomRevenueProjection.js";

/** Start only; caller owns READ COMMITTED through full acceptance or rollback.
 * Public authority takes the existing property inventory mutation lock BEFORE
 * reading receipts/quote acceptance, serializing cooperating writers through
 * commit. Do not replace it with an unlocked authority lookup. Completed replay
 * precedes all fresh owners. Fresh returns an IN-PROGRESS receipt, never success;
 * caller must finish every write and the final deadline gate, or roll back all. */
export async function preparePricingAcceptance(client: PoolClient, slug: unknown, input: unknown) {
  const fail = (): never => {
    throw new Error("Booking acceptance unavailable");
  };
  if (
    !pricingObject(input) ||
    typeof input.quoteId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.quoteId)
  )
    return fail();
  const scope = await lockPublicPricingAuthority(client, slug);
  if (!scope) return fail();
  // Separate read after the authority lock wait observes the winner's commit.
  const replay = await replayPricingAcceptance(client, slug, input);
  if (replay) {
    if (!isDeepStrictEqual(await lockPublicPricingAuthority(client, slug), scope)) return fail();
    return { kind: "replayed" as const, ...replay };
  }
  const accepted = await client.query(
    "SELECT id FROM booking.pricing_quote_acceptances WHERE pricing_quote_id=$1 AND property_id=$2 LIMIT 1",
    [input.quoteId, scope.propertyId],
  );
  if (accepted.rows.length) return fail();
  const disclosure = await lockCurrentQuoteGuestDisclosure(client, slug, input.quoteId);
  const current = await lockCurrentQuoteRevalidation(client, slug, input.quoteId);
  if (
    !disclosure ||
    !current ||
    !isDeepStrictEqual(current.scope, scope) ||
    !isDeepStrictEqual(disclosure.quote, current.quote)
  )
    return fail();
  const command = parseBookingQuoteAcceptanceInput(input, current.quote, disclosure.policy);
  // Match the currently implemented lifecycle/revenue composition before effects.
  if (
    !command ||
    current.quote.acceptanceMode !== "instant" ||
    current.quote.paymentMethod !== "pay_at_property" ||
    current.quote.evidence.dueNowMinor !== "0" ||
    current.quote.evidence.dueLaterMinor !== current.quote.evidence.totalMinor ||
    !pricingRoomRevenueProjection(current.quote, current.calculation?.charges)
  )
    return fail();
  const finance = await lockFinancePricingAcceptanceTerms(client, slug);
  if (!finance || !isDeepStrictEqual(finance.scope, scope)) return fail();
  const receipt = await client.query(
    `INSERT INTO platform.idempotency_keys
      (operation_scope,operation,key_hash,request_fingerprint_hash,status,tenant_scope,property_id,correlation_id,expires_at)
    VALUES('booking','booking.pricing_quote.accept',$1,$2,'in_progress','property',$3,$4,clock_timestamp()+interval '90 days')
    ON CONFLICT(operation_scope,operation,key_hash,scope_key) DO NOTHING RETURNING id::text`,
    [
      createHash("sha256").update(command.requestId).digest("hex"),
      command.fingerprint.slice(7),
      scope.propertyId,
      command.requestId,
    ],
  );
  if (
    receipt.rows.length !== 1 ||
    !isDeepStrictEqual(await lockPublicPricingAuthority(client, slug), scope)
  )
    return fail();
  return {
    kind: "fresh" as const,
    current,
    disclosure,
    command,
    finance,
    commandReceiptId: receipt.rows[0].id as string,
  };
}
