/**
 * Mirrors PayoutSettings in pms-backend/app/routers/affiliate_dashboard.py.
 * Canonical per-user payout configuration (single row per affiliate user).
 */
export interface PayoutSettings {
  paymentMethod: string
  paypalEmail: string
  bankIban: string
  bankAccountHolder: string
  bankSwiftBic: string
  bankName: string
  bankCountry: string
  xenditChannelCode: string | null
  xenditAccountNumber: string | null
  xenditAccountHolderName: string | null
}
