import { apiClient } from '../api/client'

export interface PropertySettings {
  property_name: string
  reservation_email: string
  phone_number: string
  whatsapp_number: string
  address: string
  timezone: string
  default_currency: string
  supported_languages: string[]
  email_notifications: boolean
  new_booking_alerts: boolean
  payment_alerts: boolean
  weekly_reports: boolean
}

export type PropertySettingsUpdate = Partial<PropertySettings>

export interface DesignSettings {
  hero_image: string
  hero_heading: string
  hero_subtext: string
  primary_color: string
  accent_color: string
  font_pairing: string
}

export type DesignSettingsUpdate = Partial<DesignSettings>

export const settingsService = {
  getPropertySettings: () =>
    apiClient.get<PropertySettings>('/admin/settings/property'),

  updatePropertySettings: (data: PropertySettingsUpdate) =>
    apiClient.patch<PropertySettings>('/admin/settings/property', data),

  changePassword: (current_password: string, new_password: string) =>
    apiClient.post('/auth/change-password', { current_password, new_password }),

  getDesignSettings: () =>
    apiClient.get<DesignSettings>('/admin/settings/design'),

  updateDesignSettings: (data: DesignSettingsUpdate) =>
    apiClient.patch<DesignSettings>('/admin/settings/design', data),
}
