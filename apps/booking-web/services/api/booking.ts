import { Booking } from '@/lib/types'

const PMS_URL = process.env.NEXT_PUBLIC_PMS_URL || ''

export interface BookingRequestResponse {
  booking: Booking
  clientSecret: string | null
  xenditInvoiceUrl: string | null
  paymentMethod: string
}

export interface PaymentSettings {
  payAtPropertyEnabled: boolean
  onlineCardPayment?: boolean
  bankTransfer?: boolean
  xenditPaymentsEnabled?: boolean
  payAtHotelMethods?: string[]
  freeCancellationDays: number
  specialRequestsEnabled?: boolean
  arrivalTimeEnabled?: boolean
  guestCountEnabled?: boolean
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

async function handleResponse<T>(res: Response, fallbackMessage: string): Promise<T> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: fallbackMessage }))
    throw new Error(err.detail || fallbackMessage)
  }
  return res.json()
}

async function postJson(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
}

export const bookingService = {
  async create(slug: string, data: {
    roomTypeId: string
    guestFirstName: string
    guestLastName: string
    guestEmail: string
    guestPhone: string
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
  }): Promise<BookingRequestResponse> {
    const res = await postJson(`${PMS_URL}/api/hotels/${slug}/bookings`, data)
    return handleResponse(res, 'Booking failed')
  },

  async confirmAuthorization(slug: string, bookingId: string): Promise<void> {
    const res = await postJson(`${PMS_URL}/api/hotels/${slug}/bookings/${bookingId}/confirm-authorization`)
    await handleResponse(res, 'Confirmation failed')
  },

  async withdraw(slug: string, bookingId: string, guestEmail: string): Promise<void> {
    const res = await postJson(`${PMS_URL}/api/hotels/${slug}/bookings/${bookingId}/withdraw`, { guest_email: guestEmail })
    await handleResponse(res, 'Withdrawal failed')
  },

  async cancelPreview(slug: string, bookingId: string, guestEmail: string): Promise<CancelPreview> {
    const res = await postJson(`${PMS_URL}/api/hotels/${slug}/bookings/${bookingId}/cancel-preview`, { guest_email: guestEmail })
    return handleResponse(res, 'Preview failed')
  },

  async cancel(slug: string, bookingId: string, guestEmail: string): Promise<void> {
    const res = await postJson(`${PMS_URL}/api/hotels/${slug}/bookings/${bookingId}/cancel`, { guest_email: guestEmail })
    await handleResponse(res, 'Cancellation failed')
  },

  async getStatus(slug: string, reference: string, email: string): Promise<BookingStatus> {
    const params = new URLSearchParams({ reference, email })
    const res = await fetch(`${PMS_URL}/api/hotels/${slug}/bookings/status?${params}`)
    return handleResponse(res, 'Status check failed')
  },

  async getPaymentSettings(slug: string): Promise<PaymentSettings> {
    const res = await fetch(`${PMS_URL}/api/hotels/${slug}/payment-settings`)
    if (!res.ok) {
      return { payAtPropertyEnabled: false, freeCancellationDays: 7 }
    }
    return res.json()
  },

  async lookup(slug: string, bookingReference: string, guestEmail: string): Promise<Booking> {
    const res = await postJson(`${PMS_URL}/api/hotels/${slug}/bookings/lookup`, { bookingReference, guestEmail })
    return handleResponse(res, 'Booking not found')
  },
}
