import { Booking } from '@/lib/types'

const PMS_URL = process.env.NEXT_PUBLIC_PMS_URL || ''

export interface BookingRequestResponse {
  booking: Booking
  clientSecret: string | null
  paymentMethod: string
}

export interface PaymentSettings {
  payAtPropertyEnabled: boolean
  freeCancellationDays: number
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
    specialRequests?: string
    checkIn: string
    checkOut: string
    adults: number
    children: number
    referralCode?: string
    paymentMethod?: string
  }): Promise<BookingRequestResponse> {
    const res = await fetch(`${PMS_URL}/api/hotels/${slug}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Booking failed' }))
      throw new Error(err.detail || 'Booking failed')
    }
    return res.json()
  },

  async confirmAuthorization(slug: string, bookingId: string): Promise<void> {
    const res = await fetch(`${PMS_URL}/api/hotels/${slug}/bookings/${bookingId}/confirm-authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Confirmation failed' }))
      throw new Error(err.detail || 'Confirmation failed')
    }
  },

  async withdraw(slug: string, bookingId: string, guestEmail: string): Promise<void> {
    const res = await fetch(`${PMS_URL}/api/hotels/${slug}/bookings/${bookingId}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestEmail }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Withdrawal failed' }))
      throw new Error(err.detail || 'Withdrawal failed')
    }
  },

  async cancelPreview(slug: string, bookingId: string, guestEmail: string): Promise<CancelPreview> {
    const res = await fetch(`${PMS_URL}/api/hotels/${slug}/bookings/${bookingId}/cancel-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestEmail }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Preview failed' }))
      throw new Error(err.detail || 'Preview failed')
    }
    return res.json()
  },

  async cancel(slug: string, bookingId: string, guestEmail: string): Promise<void> {
    const res = await fetch(`${PMS_URL}/api/hotels/${slug}/bookings/${bookingId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestEmail }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Cancellation failed' }))
      throw new Error(err.detail || 'Cancellation failed')
    }
  },

  async getStatus(slug: string, reference: string, email: string): Promise<BookingStatus> {
    const params = new URLSearchParams({ reference, email })
    const res = await fetch(`${PMS_URL}/api/hotels/${slug}/bookings/status?${params}`)
    if (!res.ok) {
      throw new Error('Status check failed')
    }
    return res.json()
  },

  async getPaymentSettings(slug: string): Promise<PaymentSettings> {
    const res = await fetch(`${PMS_URL}/api/hotels/${slug}/payment-settings`)
    if (!res.ok) {
      return { payAtPropertyEnabled: false, freeCancellationDays: 7 }
    }
    return res.json()
  },

  async lookup(slug: string, bookingReference: string, guestEmail: string): Promise<Booking> {
    const res = await fetch(`${PMS_URL}/api/hotels/${slug}/bookings/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingReference, guestEmail }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Booking not found' }))
      throw new Error(err.detail || 'Booking not found')
    }
    return res.json()
  },
}
