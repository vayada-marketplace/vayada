import { pmsClient } from '@/services/api/pmsClient'

export interface ChannexSyncStatus {
  isConnected: boolean
  channexPropertyId: string | null
  roomTypesProvisioned: number
  ratePlansProvisioned: number
  lastBookingSyncAt: string | null
  lastAriSyncAt: string | null
  messagingAppInstalled: boolean
}

export interface ChannexRoomTypeMapping {
  id: string
  hotelId: string
  roomTypeId: string
  roomTypeName: string | null
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

export interface ChannexEnableResult {
  status: string
  channexPropertyId: string
  roomsCreated: number
  ratesCreated: number
}

export interface ChannelMarkup {
  channel: string
  markupPct: number
}

export interface ChannelMarkupsResponse {
  markups: ChannelMarkup[]
}

export interface ConnectedChannel {
  key: string
  application: string
  title: string | null
  isActive: boolean
}

export interface ConnectedChannelsResponse {
  channels: ConnectedChannel[]
}

export const channexService = {
  // Enable / disable
  enable: () =>
    pmsClient.post<ChannexEnableResult>('/admin/channex/enable'),

  disable: () =>
    pmsClient.post('/admin/channex/disable'),

  // Status
  getStatus: () =>
    pmsClient.get<ChannexSyncStatus>('/admin/channex/status'),

  // Re-provision (after adding new room types)
  provision: () =>
    pmsClient.post<{ channexPropertyId: string; roomsCreated: number; ratesCreated: number }>('/admin/channex/provision'),

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

  // Messaging app install (idempotent retry for the requesting hotel)
  installMessagingApp: () =>
    pmsClient.post<{ status: string }>('/admin/channex/messaging/install'),

  // Channel iframe
  getIframeUrl: () =>
    pmsClient.post<{ iframe_url: string }>('/admin/channex/iframe-url'),

  // Channel pricing markups
  getMarkups: () =>
    pmsClient.get<ChannelMarkupsResponse>('/admin/channex/markups'),

  updateMarkups: (markups: ChannelMarkup[]) =>
    pmsClient.put<ChannelMarkupsResponse>('/admin/channex/markups', { markups }),

  // Connected OTA channels
  listChannels: () =>
    pmsClient.get<ConnectedChannelsResponse>('/admin/channex/channels'),
}
