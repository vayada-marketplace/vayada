/**
 * Shape returned by /affiliate/earnings. Months are zero-filled to the
 * full range, so the array length matches the requested period.
 */
export type EarningsPeriod = '1m' | '3m' | '6m' | '12m'

export interface EarningsMonth {
  month: string
  label: string
  earnings: number
}

export interface EarningsResponse {
  months: EarningsMonth[]
  currency: string
}
