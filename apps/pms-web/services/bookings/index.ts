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
  status: 'pending' | 'confirmed' | 'cancelled'
  createdAt: string
  updatedAt: string
}

export interface BookingListResponse {
  bookings: Booking[]
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
}
