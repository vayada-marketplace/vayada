import { Hotel, RoomType, Addon } from '@/lib/types'
import { apiClient } from './client'

const PMS_URL = process.env.NEXT_PUBLIC_PMS_URL || ''

export const hotelService = {
  async getHotel(slug: string, locale: string = 'en'): Promise<Hotel> {
    const langParam = locale !== 'en' ? `?lang=${locale}` : ''
    return apiClient.get<Hotel>(`/api/hotels/${slug}${langParam}`)
  },

  async getRooms(slug: string, checkIn?: string, checkOut?: string, adults?: number): Promise<RoomType[]> {
    const params = new URLSearchParams()
    if (checkIn) params.set('check_in', checkIn)
    if (checkOut) params.set('check_out', checkOut)
    if (adults) params.set('adults', String(adults))
    const qs = params.toString()
    const base = PMS_URL || process.env.NEXT_PUBLIC_API_URL || ''
    const res = await fetch(`${base}/api/hotels/${slug}/rooms${qs ? `?${qs}` : ''}`)
    if (!res.ok) throw new Error(`API error: ${res.status}`)
    return res.json()
  },

  async getAddons(slug: string): Promise<Addon[]> {
    return apiClient.get<Addon[]>(`/api/hotels/${slug}/addons`)
  },

  async getUnavailableDates(slug: string, start: string, end: string): Promise<string[]> {
    const base = PMS_URL || process.env.NEXT_PUBLIC_API_URL || ''
    const res = await fetch(`${base}/api/hotels/${slug}/unavailable-dates?start=${start}&end=${end}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.dates || []
  },

  async validatePromoCode(slug: string, code: string): Promise<{
    valid: boolean
    code: string
    discountType?: string
    discountValue?: number
    message: string
  }> {
    return apiClient.get(`/api/hotels/${slug}/validate-promo?code=${encodeURIComponent(code)}`)
  },
}
