import { apiClient } from '../api/client'

export interface PropertySettings {
  property_name: string
  reservation_email: string
  phone_number: string
  timezone: string
  default_currency: string
  supported_languages: string[]
}

export type PropertySettingsUpdate = Partial<PropertySettings>

export const settingsService = {
  getPropertySettings: () =>
    apiClient.get<PropertySettings>('/admin/settings/property'),

  updatePropertySettings: (data: PropertySettingsUpdate) =>
    apiClient.patch<PropertySettings>('/admin/settings/property', data),
}
