import { pmsClient } from '../api/pmsClient'

export interface AffiliatePayoutSummary {
  affiliateId: string
  fullName: string
  email: string
  hotelId: string
  hotelName: string
  hotelSlug: string
  paymentMethod: string
  paypalEmail: string
  bankAccountHolder: string
  bankIban: string
  bankSwiftBic: string
  bankName: string
  bankCountry: string
  stripeConnectAccountId: string | null
  stripeConnectOnboarded: boolean
  outstandingAmount: number
  paidAmount: number
  currency: string
  unpaidCount: number
  lastPaidAt: string | null
}

export interface BookingPayoutLine {
  payoutId: string
  bookingId: string
  bookingReference: string
  guestName: string
  checkIn: string
  checkOut: string
  bookingTotal: number
  commission: number
  currency: string
  status: 'scheduled' | 'processing' | 'failed' | 'completed'
  scheduledFor: string | null
  completedAt: string | null
  paymentMethod: string | null
  externalReference: string | null
}

export interface PayoutHistoryEntry {
  completedAt: string
  paymentMethod: string
  externalReference: string | null
  notes: string | null
  amount: number
  currency: string
  bookingCount: number
}

export interface AffiliatePayoutDetail {
  affiliate: {
    id: string
    fullName: string
    email: string
    hotelId: string
    hotelName: string
    hotelSlug: string
    paymentMethod: string
    paypalEmail: string
    bankAccountHolder: string
    bankIban: string
    bankSwiftBic: string
    bankName: string
    bankCountry: string
    stripeConnectAccountId: string | null
    stripeConnectOnboarded: boolean
  }
  outstandingAmount: number
  paidAmount: number
  lines: BookingPayoutLine[]
  history: PayoutHistoryEntry[]
}

export interface MarkPaidRequest {
  paymentMethod: string
  externalReference?: string
  notes?: string
}

export interface MarkPaidResponse {
  affiliateId: string
  rowCount: number
  amount: number
  currency: string
}

export const superAdminPayoutsService = {
  list: () =>
    pmsClient.get<{ affiliates: AffiliatePayoutSummary[] }>('/super-admin/affiliate-payouts'),

  get: (affiliateId: string) =>
    pmsClient.get<AffiliatePayoutDetail>(`/super-admin/affiliate-payouts/${affiliateId}`),

  markPaid: (affiliateId: string, body: MarkPaidRequest) =>
    pmsClient.post<MarkPaidResponse>(`/super-admin/affiliate-payouts/${affiliateId}/mark-paid`, body),
}
