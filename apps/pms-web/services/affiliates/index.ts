import { pmsClient } from '../api/pmsClient'

export interface Affiliate {
  id: string
  hotelId: string
  referralCode: string
  fullName: string
  email: string
  socialMedia: string
  userType: 'guest' | 'creator'
  paymentMethod: 'paypal' | 'bank' | 'stripe' | 'xendit'
  paypalEmail: string
  bankIban: string
  commissionPct: number
  status: 'pending' | 'approved' | 'rejected' | 'suspended'
  createdAt: string
  updatedAt: string
  bookingCount: number
  totalRevenue: number
  totalCommission: number
  clickCount: number
  conversionRate: number
  stripeConnectAccountId: string | null
  stripeConnectOnboarded: boolean
  xenditChannelCode: string | null
  xenditAccountNumber: string | null
  xenditAccountHolderName: string | null
}

export interface AffiliateListResponse {
  affiliates: Affiliate[]
  total: number
  limit: number
  offset: number
}

export const affiliatesService = {
  list: (params?: { status?: string; limit?: number; offset?: number }) => {
    const query = new URLSearchParams()
    if (params?.status) query.set('status', params.status)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return pmsClient.get<AffiliateListResponse>(`/admin/affiliates${qs ? `?${qs}` : ''}`)
  },

  get: (id: string) =>
    pmsClient.get<Affiliate>(`/admin/affiliates/${id}`),

  updateStatus: (id: string, status: 'approved' | 'rejected' | 'suspended') =>
    pmsClient.patch<Affiliate>(`/admin/affiliates/${id}/status`, { status }),

  updateCommission: (id: string, commissionPct: number) =>
    pmsClient.patch<Affiliate>(`/admin/affiliates/${id}/commission`, { commissionPct }),

  createStripeAccount: (affiliateId: string, email: string, country: string) =>
    pmsClient.post<{ accountId: string }>(`/admin/affiliates/${affiliateId}/stripe/connect-account`, { email, country }),

  getStripeOnboardingLink: (affiliateId: string) =>
    pmsClient.get<{ url: string }>(`/admin/affiliates/${affiliateId}/stripe/connect-onboarding-link`),

  saveXenditBankDetails: (affiliateId: string, channelCode: string, accountNumber: string, accountHolderName: string) =>
    pmsClient.post<Affiliate>(`/admin/affiliates/${affiliateId}/xendit/bank-details`, {
      channelCode,
      accountNumber,
      accountHolderName,
    }),
}
