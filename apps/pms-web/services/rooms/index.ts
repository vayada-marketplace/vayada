import { pmsClient } from '../api/pmsClient'

export interface MonthlyRate {
  baseRate?: number | null
  nonRefundableRate?: number | null
}

export interface RoomType {
  id: string
  hotelId: string
  name: string
  category: string
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
  benefits: string[]
  totalRooms: number
  isActive: boolean
  sortOrder: number
  monthlyRates: Record<string, MonthlyRate>
  operatingPeriods: { from: string; to: string }[]
  seasons: { name: string; tier: string; from: string; to: string; rate: string; minStay: number }[]
  weekendSurcharge: string
  cancellationPolicy: string
  flexibleRateEnabled: boolean
  nonRefundableEnabled: boolean
  nonRefundableDiscount: number
  createdAt: string
  updatedAt: string
}

export interface RoomTypeCreate {
  name: string
  category?: string
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
  benefits?: string[]
  totalRooms?: number
  isActive?: boolean
  sortOrder?: number
  monthlyRates?: Record<string, MonthlyRate>
  operatingPeriods?: { from: string; to: string }[]
  seasons?: { name: string; tier: string; from: string; to: string; rate: string; minStay: number }[]
  weekendSurcharge?: string
  cancellationPolicy?: string
  flexibleRateEnabled?: boolean
  nonRefundableEnabled?: boolean
  nonRefundableDiscount?: number
}

export type RoomTypeUpdate = Partial<RoomTypeCreate>

export interface Room {
  id: string
  hotelId: string
  roomTypeId: string
  roomTypeName: string
  roomNumber: string
  floor: string
  status: 'available' | 'maintenance' | 'out_of_order'
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface RoomCreate {
  roomTypeId: string
  roomNumber: string
  floor?: string
  status?: string
  sortOrder?: number
}

export const individualRoomsService = {
  list: () =>
    pmsClient.get<Room[]>('/admin/rooms'),

  create: (data: RoomCreate) =>
    pmsClient.post<Room>('/admin/rooms', data),

  update: (id: string, data: Partial<RoomCreate>) =>
    pmsClient.patch<Room>(`/admin/rooms/${id}`, data),

  delete: (id: string) =>
    pmsClient.delete(`/admin/rooms/${id}`),
}

export const benefitsService = {
  get: () =>
    pmsClient.get<{ benefits: string[] }>('/admin/benefits'),

  update: (benefits: string[]) =>
    pmsClient.put<{ benefits: string[] }>('/admin/benefits', { benefits }),
}

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
