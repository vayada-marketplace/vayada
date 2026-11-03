import { apiClient } from "./client";

/** A hotel's card state for Vayada finance (VAY-2205): its payment account and Finance's
 * readiness. Since VAY-2442 (Flamur, 2026-11-03) card works as soon as the hotel's own settings
 * are complete; Vayada no longer approves it, so this is read only. */
export type HotelCardPaymentsState = {
  propertyId: string;
  /** The hotel's payment account, when linked: its own Stripe account, or vayada Payment with its
   * payout bank account saved. `ready`: it can take cards. */
  providerAccount: { ready: boolean; cardCapabilityRevision: number } | null;
  propertyReadinessRevision: number | null;
  /** What card also needs from the hotel's Payment settings. */
  paymentSettings: { paymentsOn: boolean; cardChosen: boolean; currencyEligible: boolean } | null;
  /** A Vayada approval from before VAY-2442, kept as history. It no longer decides anything. */
  evidence: {
    evidenceId: string;
    acceptedAt: string;
    acceptedByUserId: string | null;
    current: boolean;
  } | null;
  cardReady: boolean;
  /** Whether the hotel's published prices must be saved again: only when the system couldn't
   * publish them again after a change (VAY-2304). */
  prices?: "current" | "save_needed" | "not_published";
};

/** What the Payments tab shows: card is on while Finance says it is ready, which needs only the
 * hotel's own steps below. */
export function hotelCardPaymentsView(state: HotelCardPaymentsState) {
  const settings = state.paymentSettings;
  return {
    on: state.cardReady,
    linked: state.providerAccount !== null,
    accountReady: state.providerAccount?.ready === true,
    /** The hotel's own choice: payments on, card among them, in a currency card can take. */
    hotelChoseCard:
      settings?.paymentsOn === true && settings.cardChosen && settings.currencyEligible,
    currencyEligible: settings?.currencyEligible !== false,
    pricesSaveNeeded: state.prices === "save_needed",
  };
}

const path = (propertyId: string) =>
  `/api/finance/platform/properties/${encodeURIComponent(propertyId)}/online-card-execution-evidence`;

export const hotelCardPaymentsService = {
  read: (propertyId: string) => apiClient.get<HotelCardPaymentsState>(path(propertyId)),
};
