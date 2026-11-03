import type { FinancePaymentReadinessReadPort } from "@vayada/domain-finance";

/** Whether a rate can take card (and deposits) on the booking page now, for the PMS rate screens (VAY-2205):
 * - ready only when Finance's own card readiness (the hotel's payment account and currency) is ready and card
 *   acceptance is switched on; no Vayada approval since VAY-2442 (Flamur, 2026-11-03);
 * - `reason` names the first thing missing: the hotel's payment account, its currency, the switch;
 * - `charge` is when the guest's card is charged: at booking (instant book) or when the hotel accepts (request);
 * - deposits (a share by card when booking, the rest at the property) need card ready and deposits switched on. */
export type PricingCardReadiness = Readonly<{
  card: Readonly<{
    ready: boolean;
    reason: "not_connected" | "currency" | "switch_off" | null;
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
  depositAcceptanceEnabled: boolean;
}): PricingCardReadinessReadPort {
  return {
    async read({ organizationId, propertyId }) {
      const [snapshot, local] = await Promise.all([
        config.finance.getPaymentReadiness({ organizationId, propertyId }),
        config.pool.query(
          `SELECT (SELECT acceptance_mode FROM booking.booking_settings WHERE property_id=$1) AS mode`,
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
              ? "not_connected"
              : config.cardAcceptanceEnabled
                ? null
                : "switch_off";
      return {
        card: { ready: reason === null, reason, charge },
        deposits: { ready: reason === null && config.depositAcceptanceEnabled },
      };
    },
  };
}
