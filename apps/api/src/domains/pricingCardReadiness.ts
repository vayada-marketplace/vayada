import type { FinancePaymentReadinessReadPort } from "@vayada/domain-finance";

/** Whether a rate can take card (and deposits) on the booking page now, for the PMS rate screens (VAY-2205):
 * - ready only when Finance's own card readiness (Stripe account, currency, Vayada's card approval) is ready and
 *   card acceptance is switched on;
 * - `reason` names the first thing missing: the hotel's Stripe account, its currency, Vayada's approval, the switch;
 * - `charge` is when the guest's card is charged: at booking (instant book) or when the hotel accepts (request);
 * - deposits stay off until deposit execution ships. */
export type PricingCardReadiness = Readonly<{
  card: Readonly<{
    ready: boolean;
    reason: "not_connected" | "currency" | "not_approved" | "switch_off" | null;
    charge: "at_booking" | "on_accept";
  }>;
  deposits: Readonly<{ ready: boolean }>;
}>;
export type PricingCardReadinessReadPort = {
  read(request: { organizationId: string; propertyId: string }): Promise<PricingCardReadiness>;
};

type QueryPool = { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };

export function createPricingCardReadinessReader(config: {
  pool: QueryPool;
  finance: FinancePaymentReadinessReadPort;
  cardAcceptanceEnabled: boolean;
}): PricingCardReadinessReadPort {
  return {
    async read({ organizationId, propertyId }) {
      const [snapshot, local] = await Promise.all([
        config.finance.getPaymentReadiness({ organizationId, propertyId }),
        // Finance reports a missing Stripe account and missing approval alike; the linked account tells them apart.
        config.pool.query(
          `SELECT (SELECT acceptance_mode FROM booking.booking_settings WHERE property_id=$1) AS mode,
            EXISTS(SELECT 1 FROM finance.payment_settings settings JOIN finance.payment_provider_accounts account
              ON account.id=settings.provider_account_id AND account.property_id=settings.property_id
              WHERE settings.property_id=$1) AS linked`,
          [propertyId],
        ),
      ]);
      // Hotels without a settings row book instantly (0080).
      const charge = local.rows[0]?.mode === "request" ? "on_accept" : "at_booking";
      const card = snapshot?.paymentsEnabled
        ? snapshot.methods.find(({ method }) => method === "card")
        : undefined;
      const blocked = (blocker: string) => card?.blockers.some((b) => b === blocker) === true;
      const reason =
        !card?.selected ||
        card.availability !== "available" ||
        blocked("provider_restricted") ||
        blocked("provider_capability_lost") ||
        blocked("payment_settings_uncommitted")
          ? "not_connected"
          : blocked("online_card_currency_unsupported") ||
              blocked("pricing_currency_unavailable") ||
              blocked("pricing_currency_mismatch")
            ? "currency"
            : card.readiness !== "ready"
              ? local.rows[0]?.linked === true
                ? "not_approved"
                : "not_connected"
              : config.cardAcceptanceEnabled
                ? null
                : "switch_off";
      return { card: { ready: reason === null, reason, charge }, deposits: { ready: false } };
    },
  };
}
