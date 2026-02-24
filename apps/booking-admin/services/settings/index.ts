import { apiClient } from '../api/client'

export interface PropertySettings {
  slug: string
  property_name: string
  reservation_email: string
  phone_number: string
  whatsapp_number: string
  address: string
  default_currency: string
  supported_currencies: string[]
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
  booking_filters: string[]
}

export type DesignSettingsUpdate = Partial<DesignSettings>

export interface SetupPrefillData {
  property_name?: string
  reservation_email?: string
  phone_number?: string
  address?: string
  hero_image?: string
}

export interface SetupStatusResponse {
  setup_complete: boolean
  missing_fields: string[]
  prefill_data?: SetupPrefillData | null
}

export interface HotelSummary {
  id: string
  name: string
  slug: string
  location: string
  country: string
}

export interface AddonItem {
  id: string
  name: string
  description: string
  price: number
  currency: string
  category: string
  image: string
  duration?: string
  perPerson?: boolean
}

export interface SuperAdminHotel extends HotelSummary {
  owner_name: string
  owner_email: string
}

export interface AddonSettings {
  showAddonsStep: boolean
  groupAddonsByCategory: boolean
}

export const settingsService = {
  listHotels: () =>
    apiClient.get<HotelSummary[]>('/admin/hotels'),

  listAllHotels: () =>
    apiClient.get<SuperAdminHotel[]>('/admin/superadmin/hotels'),


  getPropertySettings: () =>
    apiClient.get<PropertySettings>('/admin/settings/property'),

  updatePropertySettings: (data: PropertySettingsUpdate) =>
    apiClient.patch<PropertySettings>('/admin/settings/property', data),

  changePassword: (current_password: string, new_password: string) =>
    apiClient.post('/auth/change-password', { current_password, new_password }),

  changeEmail: (new_email: string, password: string) =>
    apiClient.post<{ message: string; email: string }>('/auth/change-email', { new_email, password }),

  getDesignSettings: () =>
    apiClient.get<DesignSettings>('/admin/settings/design'),

  updateDesignSettings: (data: DesignSettingsUpdate) =>
    apiClient.patch<DesignSettings>('/admin/settings/design', data),

  getSetupStatus: () =>
    apiClient.get<SetupStatusResponse>('/admin/settings/setup-status'),

  listAddons: () =>
    apiClient.get<AddonItem[]>('/admin/addons'),

  createAddon: (data: Omit<AddonItem, 'id'>) =>
    apiClient.post<AddonItem>('/admin/addons', data),

  updateAddon: (id: string, data: Partial<AddonItem>) =>
    apiClient.patch<AddonItem>(`/admin/addons/${id}`, data),

  deleteAddon: (id: string) =>
    apiClient.delete(`/admin/addons/${id}`),

  getAddonSettings: () =>
    apiClient.get<AddonSettings>('/admin/settings/addons'),

  updateAddonSettings: (data: Partial<AddonSettings>) =>
    apiClient.patch<AddonSettings>('/admin/settings/addons', data),
}
