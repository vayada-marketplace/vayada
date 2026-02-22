import { Booking } from '@/lib/types'

const PMS_URL = process.env.NEXT_PUBLIC_PMS_URL || ''

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
  }): Promise<Booking> {
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
