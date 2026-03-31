import { pmsClient } from '@/services/api/pmsClient'

export interface ChannexConnection {
  id: string
  hotelId: string
  channexPropertyId: string | null
  isActive: boolean
  lastBookingSyncAt: string | null
  lastAriSyncAt: string | null
  createdAt: string
}

export interface ChannexSyncStatus {
  isConnected: boolean
  channexPropertyId: string | null
  roomTypesProvisioned: number
  ratePlansProvisioned: number
  lastBookingSyncAt: string | null
  lastAriSyncAt: string | null
}

export interface ChannexRoomTypeMapping {
  id: string
  hotelId: string
  roomTypeId: string
  channexRoomTypeId: string
  createdAt: string
}

export interface ChannexRatePlanMapping {
  id: string
  hotelId: string
  roomTypeId: string
  channexRatePlanId: string
  channexRoomTypeId: string
  sellMode: string
  createdAt: string
}

export interface ChannexProvisionResult {
  channexPropertyId: string
  roomsCreated: number
  ratesCreated: number
}

export const channexService = {
  // Connection
  connect: (apiKey: string) =>
    pmsClient.post<ChannexConnection>('/admin/channex/connect', { apiKey }),

  getConnection: () =>
    pmsClient.get<ChannexConnection>('/admin/channex/connection'),

  disconnect: () =>
    pmsClient.delete('/admin/channex/connection'),

  // Status
  getStatus: () =>
    pmsClient.get<ChannexSyncStatus>('/admin/channex/status'),

  // Provisioning
  provision: () =>
    pmsClient.post<ChannexProvisionResult>('/admin/channex/provision'),

  // Mappings
  listRoomTypeMappings: () =>
    pmsClient.get<ChannexRoomTypeMapping[]>('/admin/channex/room-type-mappings'),

  listRatePlanMappings: () =>
    pmsClient.get<ChannexRatePlanMapping[]>('/admin/channex/rate-plan-mappings'),

  // Sync
  syncAri: () =>
    pmsClient.post<{ status: string }>('/admin/channex/sync-ari'),

  syncBookings: () =>
    pmsClient.post<{ status: string }>('/admin/channex/sync-bookings'),
}
