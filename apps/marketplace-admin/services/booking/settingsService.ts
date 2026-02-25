import { bookingApiClient, hotelHeaders } from '../api/bookingClient'

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

export const bookingSettingsService = {
  listAllHotels: () =>
    bookingApiClient.get<SuperAdminHotel[]>('/admin/superadmin/hotels'),

  createHotelForUser: (userId: string, name: string) =>
    bookingApiClient.post<{ id: string; name: string; slug: string }>(
      '/admin/superadmin/hotels',
      { user_id: userId, name },
    ),

  getPropertySettings: (hotelId: string) =>
    bookingApiClient.get<PropertySettings>('/admin/settings/property', hotelHeaders(hotelId)),

  updatePropertySettings: (hotelId: string, data: PropertySettingsUpdate) =>
    bookingApiClient.patch<PropertySettings>('/admin/settings/property', data, hotelHeaders(hotelId)),

  getDesignSettings: (hotelId: string) =>
    bookingApiClient.get<DesignSettings>('/admin/settings/design', hotelHeaders(hotelId)),

  updateDesignSettings: (hotelId: string, data: DesignSettingsUpdate) =>
    bookingApiClient.patch<DesignSettings>('/admin/settings/design', data, hotelHeaders(hotelId)),

  listAddons: (hotelId: string) =>
    bookingApiClient.get<AddonItem[]>('/admin/addons', hotelHeaders(hotelId)),

  createAddon: (hotelId: string, data: Omit<AddonItem, 'id'>) =>
    bookingApiClient.post<AddonItem>('/admin/addons', data, hotelHeaders(hotelId)),

  updateAddon: (hotelId: string, id: string, data: Partial<AddonItem>) =>
    bookingApiClient.patch<AddonItem>(`/admin/addons/${id}`, data, hotelHeaders(hotelId)),

  deleteAddon: (hotelId: string, id: string) =>
    bookingApiClient.delete(`/admin/addons/${id}`, hotelHeaders(hotelId)),

  getAddonSettings: (hotelId: string) =>
    bookingApiClient.get<AddonSettings>('/admin/settings/addons', hotelHeaders(hotelId)),

  updateAddonSettings: (hotelId: string, data: Partial<AddonSettings>) =>
    bookingApiClient.patch<AddonSettings>('/admin/settings/addons', data, hotelHeaders(hotelId)),
}
