import { pmsClient } from '../api/pmsClient'

export interface Beds24Connection {
  id: string
  hotelId: string
  beds24PropertyId: string | null
  isActive: boolean
  lastSyncAt: string | null
  createdAt: string
}

export interface Beds24Property {
  id: string
  name: string
}

export interface Beds24Room {
  id: string
  name: string
  qty: number
}

export interface Beds24RoomMapping {
  id: string
  hotelId: string
  roomTypeId: string
  beds24RoomId: string
  createdAt: string
}

export const beds24Service = {
  connect: (inviteCode: string) =>
    pmsClient.post<Beds24Connection>('/admin/beds24/connect', { inviteCode }),

  getConnection: () =>
    pmsClient.get<Beds24Connection>('/admin/beds24/connection'),

  disconnect: () =>
    pmsClient.delete('/admin/beds24/connection'),

  listProperties: () =>
    pmsClient.get<Beds24Property[]>('/admin/beds24/properties'),

  setProperty: (beds24PropertyId: string) =>
    pmsClient.post<Beds24Connection>('/admin/beds24/property', { beds24PropertyId }),

  listRooms: () =>
    pmsClient.get<Beds24Room[]>('/admin/beds24/rooms'),

  listRoomMappings: () =>
    pmsClient.get<Beds24RoomMapping[]>('/admin/beds24/room-mappings'),

  createRoomMapping: (roomTypeId: string, beds24RoomId: string) =>
    pmsClient.post<Beds24RoomMapping>('/admin/beds24/room-mappings', { roomTypeId, beds24RoomId }),

  deleteRoomMapping: (mappingId: string) =>
    pmsClient.delete(`/admin/beds24/room-mappings/${mappingId}`),

  syncAvailability: () =>
    pmsClient.post<{ status: string }>('/admin/beds24/sync-availability'),

  syncBookings: () =>
    pmsClient.post<{ status: string }>('/admin/beds24/sync-bookings'),
}
