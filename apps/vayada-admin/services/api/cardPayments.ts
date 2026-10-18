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

/** What the Payments tab shows (VAY-2205 P2.2, approved by Flamur 2026-10-18). */
export function hotelCardPaymentsView(state: HotelCardPaymentsState) {
  const linked = state.providerAccount !== null;
  const stripeReady = state.providerAccount?.ready === true;
  const on = state.evidence !== null;
  return {
    on,
    linked,
    stripeReady,
    approval: state.evidence,
    // Vayada approves only a ready Stripe account, against the revisions it checked.
    canTurnOn:
      !on &&
      stripeReady &&
      !!state.propertyReadinessRevision &&
      state.propertyReadinessRevision > 0,
  };
}

const path = (propertyId: string) =>
  `/api/finance/platform/properties/${encodeURIComponent(propertyId)}/online-card-execution-evidence`;

async function sha256Hex(text: string) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const hotelCardPaymentsService = {
  read: (propertyId: string) => apiClient.get<HotelCardPaymentsState>(path(propertyId)),

  /** Vayada's approval: the operator attests that they checked the hotel's Stripe account. The
   * fingerprint binds that statement to the revisions it was given for. */
  turnOn: async (state: HotelCardPaymentsState, now = new Date()) => {
    if (!state.providerAccount || !state.propertyReadinessRevision)
      throw new Error("The hotel's Stripe account isn't ready.");
    // A little before now, so the server never sees an attestation from its future.
    const executedAt = new Date(now.getTime() - 5_000).toISOString();
    const evidenceFingerprintHash = await sha256Hex(
      [
        "vayada-card-approval.v1",
        state.propertyId,
        `card-capability:${state.providerAccount.cardCapabilityRevision}`,
        `property-readiness:${state.propertyReadinessRevision}`,
        executedAt,
      ].join("\n"),
    );
    return apiClient.post<unknown>(path(state.propertyId), {
      commandId: globalThis.crypto.randomUUID(),
      idempotencyKey: globalThis.crypto.randomUUID(),
      expectedCardCapabilityRevision: state.providerAccount.cardCapabilityRevision,
      expectedPropertyReadinessRevision: state.propertyReadinessRevision,
      evidenceFingerprintHash,
      executedAt,
    });
  },

  turnOff: (propertyId: string, evidenceId: string) =>
    apiClient.post<unknown>(`${path(propertyId)}/${encodeURIComponent(evidenceId)}/revoke`, {
      commandId: globalThis.crypto.randomUUID(),
      idempotencyKey: globalThis.crypto.randomUUID(),
    }),
};
