/**
 * Shape returned by /affiliate/payouts. The backend builds the dict
 * inline (not from the PayoutEntry pydantic model), so this type tracks
 * the actual JSON, including fields like bookingCount and reference.
 */
export interface Payout {
  id: string
  date: string
  amount: number
  currency: string
  method: string
  reference: string | null
  bookingCount: number
  status: string
}

export interface PayoutsResponse {
  payouts: Payout[]
}
