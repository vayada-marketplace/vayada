import { pmsClient } from '../api/pmsClient'
import { buildQueryString } from '@/lib/utils/queryString'

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
  addonIds: string[]
  addonTotal: number
  addonQuantities: Record<string, number>
  estimatedArrivalTime: string | null
  numberOfGuests: number | null
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
  xenditPaymentsEnabled: boolean
  paymentProvider: 'stripe' | 'xendit'
  xenditChannelCode: string | null
  xenditAccountNumber: string | null
  xenditAccountHolderName: string | null
  defaultCurrency: string
}

export interface CancellationPolicy {
  freeCancellationDays: number
  partialRefundPct: number
}

export interface PaymentSettingsResponse {
  paymentSettings: PaymentSettings
  cancellationPolicy: CancellationPolicy
}

export const bookingsService = {
  list: (params?: { status?: string; search?: string; limit?: number; offset?: number }) => {
    const qs = buildQueryString(params)
    return pmsClient.get<BookingListResponse>(`/admin/bookings${qs}`)
  },

  get: (id: string) =>
    pmsClient.get<Booking>(`/admin/bookings/${id}`),

  updateStatus: (id: string, status: 'confirmed' | 'cancelled') =>
    pmsClient.patch<Booking>(`/admin/bookings/${id}/status`, { status }),

  acceptBooking: (id: string) =>
    pmsClient.post<Booking>(`/admin/bookings/${id}/accept`, {}),

  rejectBooking: (id: string) =>
    pmsClient.post<Booking>(`/admin/bookings/${id}/reject`, {}),

  assignRoom: (id: string, roomId: string) =>
    pmsClient.patch<Booking>(`/admin/bookings/${id}/assign-room`, { roomId }),

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

}
