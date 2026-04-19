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
  bankAccountHolder: string
  bankSwiftBic: string
  bankName: string
  bankCountry: string
  defaultCommissionPct: number
  commissionPctOverride: number | null
  effectiveCommissionPct: number
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

export interface DefaultAffiliateCommission {
  defaultCommissionPct: number
}

export const affiliatesService = {
  list: (params?: { status?: string; limit?: number; offset?: number }) => {
    const parts: string[] = []
    if (params?.status) parts.push(`status=${encodeURIComponent(params.status)}`)
    if (params?.limit !== undefined) parts.push(`limit=${params.limit}`)
    if (params?.offset !== undefined) parts.push(`offset=${params.offset}`)
    const qs = parts.length > 0 ? `?${parts.join('&')}` : ''
    return pmsClient.get<AffiliateListResponse>(`/admin/affiliates${qs}`)
  },

  get: (id: string) =>
    pmsClient.get<Affiliate>(`/admin/affiliates/${id}`),

  updateStatus: (id: string, status: 'approved' | 'rejected' | 'suspended') =>
    pmsClient.patch<Affiliate>(`/admin/affiliates/${id}/status`, { status }),

  updateCommission: (id: string, commissionPct: number | null) =>
    pmsClient.patch<Affiliate>(`/admin/affiliates/${id}/commission`, { commissionPct }),

  getDefaultCommission: () =>
    pmsClient.get<DefaultAffiliateCommission>('/admin/affiliates/default-commission'),

  updateDefaultCommission: (defaultCommissionPct: number) =>
    pmsClient.patch<DefaultAffiliateCommission>('/admin/affiliates/default-commission', { defaultCommissionPct }),
}
