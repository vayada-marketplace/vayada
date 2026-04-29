import { Hotel, RoomType, Addon } from '@/lib/types'
import { bookingEngine, pms } from './client'

export const hotelService = {
  async getHotel(slug: string, locale: string = 'en'): Promise<Hotel> {
    const langParam = locale !== 'en' ? `?lang=${locale}` : ''
    return bookingEngine.get<Hotel>(`/api/hotels/${slug}${langParam}`)
  },

  async recordAffiliateClick(slug: string, referralCode: string): Promise<void> {
    try {
      await fetch(`${pms.baseURL}/api/hotels/${slug}/affiliates/${referralCode}/click`, {
        method: 'POST',
        keepalive: true,
      })
    } catch {
      // Click tracking is best-effort — never block UX on it.
    }
  },

  async getRooms(slug: string, checkIn?: string, checkOut?: string, adults?: number): Promise<RoomType[]> {
    const params = new URLSearchParams()
    if (checkIn) params.set('check_in', checkIn)
    if (checkOut) params.set('check_out', checkOut)
    if (adults) params.set('adults', String(adults))
    const qs = params.toString()
    return pms.get<RoomType[]>(`/api/hotels/${slug}/rooms${qs ? `?${qs}` : ''}`)
  },

  async getAddons(slug: string): Promise<Addon[]> {
    return bookingEngine.get<Addon[]>(`/api/hotels/${slug}/addons`)
  },

  async getUnavailableDates(slug: string, start: string, end: string): Promise<{
    dates: string[]
    minStayByArrival: Record<string, number>
  }> {
    try {
      const data = await pms.get<{ dates?: string[]; min_stay_by_arrival?: Record<string, number> }>(
        `/api/hotels/${slug}/unavailable-dates?start=${start}&end=${end}`,
      )
      return {
        dates: data.dates || [],
        minStayByArrival: data.min_stay_by_arrival || {},
      }
    } catch {
      return { dates: [], minStayByArrival: {} }
    }
  },

  async validatePromoCode(slug: string, code: string): Promise<{
    valid: boolean
    code: string
    discountType?: string
    discountValue?: number
    message: string
  }> {
    return bookingEngine.get(`/api/hotels/${slug}/validate-promo?code=${encodeURIComponent(code)}`)
  },
}
