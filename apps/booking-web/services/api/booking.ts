import { Booking } from '@/lib/types'
import { ApiError, pms } from './client'

export interface BookingRequestResponse {
  booking: Booking
  clientSecret: string | null
  xenditInvoiceUrl: string | null
  paymentMethod: string
}

export interface BankDetails {
  accountHolder: string
  accountType?: 'iban' | 'account_number'
  iban: string
  accountNumber?: string
  bankName: string
  swift: string
}

export interface PaymentSettings {
  payAtPropertyEnabled: boolean
  onlineCardPayment?: boolean
  bankTransfer?: boolean
  bankDetails?: BankDetails
  xenditPaymentsEnabled?: boolean
  payAtHotelMethods?: string[]
  freeCancellationDays: number
  specialRequestsEnabled?: boolean
  arrivalTimeEnabled?: boolean
  guestCountEnabled?: boolean
  termsText?: string
  cancellationPolicyText?: string
}

export interface BookingStatus {
  status: string
  paymentStatus: string | null
  hostResponseDeadline: string | null
}

export interface CancelPreview {
  refundAmount: number
  refundPercentage: number
  freeCancellationDays: number
  daysUntilCheckIn: number
  currency: string
}

export const bookingService = {
  async create(slug: string, data: {
    roomTypeId: string
    guestFirstName: string
    guestLastName: string
    guestEmail: string
    guestPhone: string
    guestCountry?: string
    specialRequests?: string
    estimatedArrivalTime?: string
    numberOfGuests?: number
    checkIn: string
    checkOut: string
    adults: number
    children: number
    numberOfRooms?: number
    referralCode?: string
    paymentMethod?: string
    rateType?: string
    addonIds?: string[]
    addonQuantities?: Record<string, number>
    promoCode?: string
  }): Promise<BookingRequestResponse> {
    return pms.post(`/api/hotels/${slug}/bookings`, data)
  },

  async confirmAuthorization(slug: string, bookingId: string): Promise<void> {
    await pms.post(`/api/hotels/${slug}/bookings/${bookingId}/confirm-authorization`)
  },

  async withdraw(slug: string, bookingId: string, guestEmail: string): Promise<void> {
    await pms.post(`/api/hotels/${slug}/bookings/${bookingId}/withdraw`, { guest_email: guestEmail })
  },

  async cancelPreview(slug: string, bookingId: string, guestEmail: string): Promise<CancelPreview> {
    return pms.post(`/api/hotels/${slug}/bookings/${bookingId}/cancel-preview`, { guest_email: guestEmail })
  },

  async cancel(slug: string, bookingId: string, guestEmail: string): Promise<void> {
    await pms.post(`/api/hotels/${slug}/bookings/${bookingId}/cancel`, { guest_email: guestEmail })
  },

  async getStatus(slug: string, reference: string, email: string): Promise<BookingStatus> {
    const params = new URLSearchParams({ reference, email })
    return pms.get(`/api/hotels/${slug}/bookings/status?${params}`)
  },

  async getPaymentSettings(slug: string): Promise<PaymentSettings> {
    try {
      return await pms.get<PaymentSettings>(`/api/hotels/${slug}/payment-settings`)
    } catch (err) {
      if (err instanceof ApiError) {
        return { payAtPropertyEnabled: false, freeCancellationDays: 7 }
      }
      throw err
    }
  },

  async lookup(slug: string, bookingReference: string, guestEmail: string): Promise<Booking> {
    return pms.post(`/api/hotels/${slug}/bookings/lookup`, { bookingReference, guestEmail })
  },
}
