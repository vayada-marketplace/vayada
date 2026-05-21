import { ApiClient } from './client'

const BOOKING_API_URL = process.env.NEXT_PUBLIC_BOOKING_API_URL || 'https://booking-api.vayada.com'

export const bookingApiClient = new ApiClient(BOOKING_API_URL)

export function hotelHeaders(hotelId: string): RequestInit {
  return { headers: { 'X-Hotel-Id': hotelId } }
}
