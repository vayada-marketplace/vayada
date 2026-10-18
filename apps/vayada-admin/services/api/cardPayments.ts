import { apiClient } from "./client";

/** A hotel's card state for Vayada finance (VAY-2205): its Stripe account, Finance's readiness and
 * Vayada's approval (ONB-25A) in force. */
export type HotelCardPaymentsState = {
  propertyId: string;
  /** The hotel's Stripe account, when linked. `ready`: charges, payouts and card payments on. */
  providerAccount: { ready: boolean; cardCapabilityRevision: number } | null;
  propertyReadinessRevision: number | null;
  /** Vayada's approval in force; turning card off withdraws it. */
  evidence: { evidenceId: string; acceptedAt: string; acceptedByUserId: string | null } | null;
  cardReady: boolean;
};

/** What the Payments tab shows (VAY-2205 P2.2, approved by Flamur 2026-10-18). Card is on only
 * while Finance says it is ready; an approval on file whose Stripe account changed since is out of
 * date, and only turning card off and on again gives a new one. */
export function hotelCardPaymentsView(state: HotelCardPaymentsState) {
  const linked = state.providerAccount !== null;
  const stripeReady = state.providerAccount?.ready === true;
  const approved = state.evidence !== null;
  return {
    on: approved && state.cardReady,
    approvalOutOfDate: approved && !state.cardReady,
    linked,
    stripeReady,
    approval: state.evidence,
    // Vayada approves only a ready Stripe account, against the revisions it checked.
    canTurnOn:
      !approved &&
      stripeReady &&
      !!state.providerAccount?.cardCapabilityRevision &&
      !!state.propertyReadinessRevision &&
      state.propertyReadinessRevision > 0,
  };
}

const path = (propertyId: string) =>
  `/api/finance/platform/properties/${encodeURIComponent(propertyId)}/online-card-execution-evidence`;

export const hotelCardPaymentsService = {
  read: (propertyId: string) => apiClient.get<HotelCardPaymentsState>(path(propertyId)),

  /** Vayada's approval: the operator attests that they checked the hotel's Stripe account. The
   * server records the time and fingerprints the attestation with the revisions it names. */
  turnOn: async (state: HotelCardPaymentsState) => {
    if (!state.providerAccount || !state.propertyReadinessRevision)
      throw new Error("The hotel's Stripe account isn't ready.");
    return apiClient.post<unknown>(path(state.propertyId), {
      commandId: globalThis.crypto.randomUUID(),
      idempotencyKey: globalThis.crypto.randomUUID(),
      expectedCardCapabilityRevision: state.providerAccount.cardCapabilityRevision,
      expectedPropertyReadinessRevision: state.propertyReadinessRevision,
    });
  },

  turnOff: (propertyId: string, evidenceId: string) =>
    apiClient.post<unknown>(`${path(propertyId)}/${encodeURIComponent(evidenceId)}/revoke`, {
      commandId: globalThis.crypto.randomUUID(),
      idempotencyKey: globalThis.crypto.randomUUID(),
    }),
};
