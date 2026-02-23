import { pmsClient } from '../api/pmsClient'

export interface RoomType {
  id: string
  hotelId: string
  name: string
  description: string
  shortDescription: string
  maxOccupancy: number
  size: number
  baseRate: number
  nonRefundableRate: number | null
  currency: string
  amenities: string[]
  images: string[]
  bedType: string
  features: string[]
  totalRooms: number
  isActive: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface RoomTypeCreate {
  name: string
  description?: string
  shortDescription?: string
  maxOccupancy?: number
  size?: number
  baseRate?: number
  nonRefundableRate?: number | null
  currency?: string
  amenities?: string[]
  images?: string[]
  bedType?: string
  features?: string[]
  totalRooms?: number
  isActive?: boolean
  sortOrder?: number
}

export type RoomTypeUpdate = Partial<RoomTypeCreate>

export const roomsService = {
  list: () =>
    pmsClient.get<RoomType[]>('/admin/room-types'),

  get: (id: string) =>
    pmsClient.get<RoomType>(`/admin/room-types/${id}`),

  create: (data: RoomTypeCreate) =>
    pmsClient.post<RoomType>('/admin/room-types', data),

  update: (id: string, data: RoomTypeUpdate) =>
    pmsClient.patch<RoomType>(`/admin/room-types/${id}`, data),

  delete: (id: string) =>
    pmsClient.delete(`/admin/room-types/${id}`),
}
