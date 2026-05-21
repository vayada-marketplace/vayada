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

// Slice of the booking-engine PropertySettings the PMS reads/writes —
// shared with BE Admin so the currency selector hits the same field.
export interface PropertySettings {
  default_currency: string
}

export type PropertySettingsUpdate = Partial<PropertySettings>

export const pmsSettingsService = {
  getSetupStatus: () =>
    pmsClient.get<PmsSetupStatus>('/admin/setup-status'),

  listHotels: () =>
    apiClient.get<HotelSummary[]>('/admin/hotels'),
}

export const settingsService = {
  getPropertySettings: () =>
    apiClient.get<PropertySettings>('/admin/settings/property'),

  updatePropertySettings: (data: PropertySettingsUpdate) =>
    apiClient.patch<PropertySettings>('/admin/settings/property', data),
}
