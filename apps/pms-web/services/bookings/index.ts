import { pmsClient } from '../api/pmsClient'

export interface Booking {
  id: string
  bookingReference: string
  roomTypeId: string
  roomName: string
  guestFirstName: string
  guestLastName: string
  guestEmail: string
  guestPhone: string
  specialRequests: string
  checkIn: string
  checkOut: string
  nights: number
  adults: number
  children: number
  nightlyRate: number
  totalAmount: number
  currency: string
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired'
  roomId: string | null
  roomNumber: string | null
  channel: string
  paymentMethod: string | null
  paymentStatus: string | null
  hostResponseDeadline: string | null
  platformFeeAmount: number | null
  affiliateCommissionAmount: number | null
  propertyPayoutAmount: number | null
  guestWithdrawn: boolean
  createdAt: string
  updatedAt: string
}

export interface BookingListResponse {
  bookings: Booking[]
  total: number
  limit: number
  offset: number
}

export interface PaymentSettings {
  stripeConnectAccountId: string | null
  stripeConnectOnboarded: boolean
  platformFeeType: string
  platformFeeValue: number
  platformFeeWithAffiliate: number
  payAtPropertyEnabled: boolean
  paymentProvider: 'stripe' | 'xendit'
  xenditChannelCode: string | null
  xenditAccountNumber: string | null
  xenditAccountHolderName: string | null
}

export interface CancellationPolicy {
  freeCancellationDays: number
  partialRefundPct: number
}

export interface PaymentSettingsResponse {
  paymentSettings: PaymentSettings
  cancellationPolicy: CancellationPolicy
}

export interface Payout {
  id: string
  bookingId: string
  bookingReference: string | null
  recipientType: string
  amount: number
  currency: string
  status: string
  scheduledFor: string
  completedAt: string | null
}

export interface PayoutListResponse {
  payouts: Payout[]
  total: number
  limit: number
  offset: number
}

export const bookingsService = {
  list: (params?: { status?: string; limit?: number; offset?: number }) => {
    const query = new URLSearchParams()
    if (params?.status) query.set('status', params.status)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return pmsClient.get<BookingListResponse>(`/admin/bookings${qs ? `?${qs}` : ''}`)
  },

  get: (id: string) =>
    pmsClient.get<Booking>(`/admin/bookings/${id}`),

  updateStatus: (id: string, status: 'confirmed' | 'cancelled') =>
    pmsClient.patch<Booking>(`/admin/bookings/${id}/status`, { status }),

  acceptBooking: (id: string) =>
    pmsClient.post<Booking>(`/admin/bookings/${id}/accept`, {}),

  rejectBooking: (id: string) =>
    pmsClient.post<Booking>(`/admin/bookings/${id}/reject`, {}),

  getPaymentSettings: () =>
    pmsClient.get<PaymentSettingsResponse>('/admin/payment-settings'),

  updatePaymentSettings: (data: Partial<PaymentSettings>) =>
    pmsClient.patch('/admin/payment-settings', data),

  updateCancellationPolicy: (data: Partial<CancellationPolicy>) =>
    pmsClient.patch('/admin/cancellation-policy', data),

  createStripeAccount: (email: string, country: string) =>
    pmsClient.post<{ accountId: string }>('/admin/stripe/connect-account', { email, country }),

  getStripeOnboardingLink: () =>
    pmsClient.get<{ url: string }>('/admin/stripe/connect-onboarding-link'),

  getPayouts: (params?: { status?: string; limit?: number; offset?: number }) => {
    const query = new URLSearchParams()
    if (params?.status) query.set('status', params.status)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return pmsClient.get<PayoutListResponse>(`/admin/payouts${qs ? `?${qs}` : ''}`)
  },
}
