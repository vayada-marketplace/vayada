import { apiClient } from '../api/client'
import { pmsClient } from '../api/pmsClient'

export interface PmsSetupStatus {
  registered: boolean
  setupComplete: boolean
  roomCount: number
}

export interface HotelSummary {
  id: string
  name: string
  slug: string
  location: string
  country: string
}

export const pmsSettingsService = {
  getSetupStatus: () =>
    pmsClient.get<PmsSetupStatus>('/admin/setup-status'),

  listHotels: () =>
    apiClient.get<HotelSummary[]>('/admin/hotels'),
}
