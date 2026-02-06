import { Hotel, RoomType, Addon } from '@/lib/types'
import { apiClient } from './client'

export const hotelService = {
  async getHotel(slug: string): Promise<Hotel> {
    return apiClient.get<Hotel>(`/api/hotels/${slug}`)
  },

  async getRooms(slug: string): Promise<RoomType[]> {
    return apiClient.get<RoomType[]>(`/api/hotels/${slug}/rooms`)
  },

  async getAddons(slug: string): Promise<Addon[]> {
    return apiClient.get<Addon[]>(`/api/hotels/${slug}/addons`)
  },
}
