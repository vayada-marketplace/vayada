import { apiClient, type ApiClient } from "./client";

/** A line on the hotel's payout ledger (VAY-2584): money in minor units, as strings (any size). */
export type PayoutStatementLine = {
  id: string;
  kind:
    | "charge"
    | "refund"
    | "dispute"
    | "dispute_reversal"
    | "dispute_fee"
    | "dispute_fee_returned"
    | "payout"
    | "payout_returned"
    | "adjustment";
  currency: string;
  /** The amount itself (a card payment, a refund, a disputed amount). */
  grossMinor: string;
  /** What fees took (below zero when a fee came back). */
  feeMinor: string;
  /** What the line adds to (or takes from) what the hotel is owed: gross less fees. */
  netMinor: string;
  bookingReference: string | null;
  checkOut: string | null;
  occurredAt: string;
  /** A card payment's fee in its parts: the plan's fee and vayada Payment's. */
  fees: { planMinor: string; vayadaMinor: string; vayadaPercent: number } | null;
  /** The payout a payout line, or its return, belongs to. */
  payoutId: string | null;
};

export type PayoutStatementPayout = {
  id: string;
  currency: string;
  amountMinor: string;
  accountLast4: string;
  startedOn: string;
  paidOn: string | null;
  returnedOn: string | null;
  status: "sending" | "sent" | "returned" | "cancelled";
};

export type PayoutStatementTotals = {
  currency: string;
  nextPayout: { on: string; cutoff: string; amountMinor: string; balanceMinor: string };
  upcomingMinor: string;
  paidOutMinor: string;
  firstPaidOn: string | null;
};

/** The hotel's vayada Payment payouts and every line behind them, live money only. Owner only
 * (403 for anyone else); 404 where vayada Payment isn't set up for the hotel. */
export type PayoutStatement = {
  totals: PayoutStatementTotals[];
  account: { accountLast4: string; countryCode: string } | null;
  payouts: PayoutStatementPayout[];
  lines: PayoutStatementLine[];
};

export function getPayoutStatement(
  propertyId: string,
  client: Pick<ApiClient, "get"> = apiClient,
): Promise<PayoutStatement> {
  return client.get<PayoutStatement>(
    `/api/finance/properties/${encodeURIComponent(propertyId.trim())}/payout-statement`,
  );
}
