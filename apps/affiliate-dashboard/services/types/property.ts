/**
 * Mirrors PropertyStats in pms-backend/app/routers/affiliate_dashboard.py
 * (alias_generator=to_camel). Single canonical shape returned from
 * /affiliate/properties — both the dashboard summary and the settings
 * editor consume subsets of it.
 */
export interface AffiliateProperty {
  affiliateId: string
  hotelId: string
  hotelName: string
  hotelSlug: string
  referralCode: string
  commissionPct: number
  status: string
  bookingCount: number
  totalRevenue: number
  totalCommission: number
  clickCount: number
  conversionRate: number
  paymentMethod: string
  stripeConnectOnboarded: boolean
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

export interface PropertiesResponse {
  properties: AffiliateProperty[]
}
