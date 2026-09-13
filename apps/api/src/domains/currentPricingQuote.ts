import { lockPublicPricingAuthority } from "./publicPricingAuthority.js";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { parseStoredPricingQuote, type ReplacementPricingLine } from "@vayada/domain-booking";
import { lockPublicPricingPaymentAmounts } from "./publicPricingPaymentAmounts.js";

/** Internal issuance only; caller owns transaction and supplies server-configured lifetime. */
export async function lockCurrentPricingQuote(
  client: PoolClient,
  slug: unknown,
  input: unknown,
  method: unknown,
  lifetimeSeconds: number,
) {
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 900)
    return null;
  const payment = await lockPublicPricingPaymentAmounts(client, slug, input, method);
  if (!payment) return null;
  const { total } = payment,
    components = total.components,
    owner = components.room.owner;
  const clock = (
    await client.query(
      `WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
    SELECT now, (now AT TIME ZONE $1)::date::text AS date,
    (((now AT TIME ZONE $1)::date+1)::timestamp AT TIME ZONE $1) AS midnight FROM clock`,
      [components.lastMinute.propertyTimeZone],
    )
  ).rows[0];
  if (clock.date !== components.lastMinute.bookingLocalDate) return null;
  const issuedAt = (clock.now as Date).toISOString();
  const expiresAt = new Date(
    Math.min(clock.now.getTime() + lifetimeSeconds * 1000, clock.midnight.getTime()),
  ).toISOString();
  const lines: ReplacementPricingLine[] = [];
  const line = (
    kind: ReplacementPricingLine["kind"],
    selectionId: string | null,
    amountMinor: string,
  ) => {
    lines.push({ id: `line:${lines.length}`, kind, selectionId, amountMinor });
  };
  for (const room of components.room.rooms) {
    line("room", room.selectionId, room.roomMinor);
    line("meal", room.selectionId, room.mealMinor);
  }
  for (const addon of components.addons.lines) line("addon", null, addon.amountMinor);
  for (const discount of components.discounts.lastMinuteLines)
    line("discount", discount.selectionId, discount.amountMinor);
  line("discount", null, components.discounts.codeMinor);
  for (const charge of total.charges.charges)
    if (!charge.included) line("charge", null, charge.amountMinor);
  const terms = [
    ...new Map(
      payment.selectedTerms.map((t) => [JSON.stringify([t.roomTypeId, t.offerId]), t]),
    ).values(),
  ];
  const fx =
    "booking.no-conversion.v1:" +
    createHash("sha256")
      .update(
        JSON.stringify({
          currency: total.stay.currency,
          sources: total.componentSources,
        }),
      )
      .digest("hex");
  const quote = parseStoredPricingQuote({
    version: "stored-pricing-quote.v1",
    quoteId: randomUUID(),
    evaluatorVersion: "booking.current-quote.v1",
    paymentMethod: payment.method,
    stay: total.stay,
    evidence: {
      version: "pricing.v2",
      requestKey: total.requestKey,
      revisions: {
        ...total.componentSources,
        terms: owner.publication.sources.terms,
        finance: payment.financeEvidenceId,
        fx,
      },
      currency: total.stay.currency,
      issuedAt,
      expiresAt,
      lines,
      totalMinor: payment.totalMinor,
      dueNowMinor: payment.dueNowMinor,
      dueLaterMinor: payment.dueLaterMinor,
      terms,
      fx: [],
      paymentCapabilityEvidenceId: payment.financeEvidenceId,
      mandatoryChargeEvidenceId: total.charges.basisEvidenceId,
    },
    rooms: components.room.rooms.map(
      ({ selectionId, configurationRevision, termsRevisions, mealPlan, nights }) => ({
        selectionId,
        configurationRevision,
        termsRevisions,
        mealPlan,
        nights,
      }),
    ),
  });
  if (!quote || !(await lockPublicPricingAuthority(client, slug))) return null;
  return {
    quote,
    calculation: structuredClone({
      version: "booking.quote-calculation.v1" as const,
      charges: total.charges,
      addons: components.addons,
      discounts: components.discounts,
      lastMinute: components.lastMinute,
      code: components.code,
      paymentEvidenceId: payment.paymentEvidenceId,
    }),
  };
}
