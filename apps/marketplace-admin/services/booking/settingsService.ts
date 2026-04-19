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
  billing_active_plan: string
  billing_pending_switch: string | null
  billing_switch_effective_date: string | null
  booking_engine_fee_pct: number
  channel_manager_fee_pct: number
  affiliate_platform_fee_pct: number
  fixed_base_fee: number
  fixed_rooms_included: number
  fixed_per_extra_room_fee: number
  active_room_count: number
  fixed_plan_projected_monthly_fee: number
}

export interface HotelBillingUpdate {
  booking_engine_fee_pct?: number
  channel_manager_fee_pct?: number
  affiliate_platform_fee_pct?: number
  fixed_base_fee?: number
  fixed_rooms_included?: number
  fixed_per_extra_room_fee?: number
}

export interface AddonSettings {
  showAddonsStep: boolean
  groupAddonsByCategory: boolean
}

export interface PromoCodeItem {
  id: string
  code: string
  discountType: 'percentage' | 'fixed'
  discountValue: number
  validFrom?: string | null
  validUntil?: string | null
  isActive: boolean
  maxUses?: number | null
  useCount: number
  createdAt?: string
}

export const bookingSettingsService = {
  listAllHotels: () =>
    bookingApiClient.get<SuperAdminHotel[]>('/admin/superadmin/hotels'),

  updateHotelBilling: (hotelId: string, data: HotelBillingUpdate) =>
    bookingApiClient.patch(`/admin/superadmin/hotels/${hotelId}/billing`, data),

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

  // Benefits
  getBenefits: (hotelId: string) =>
    bookingApiClient.get<{ benefits: string[] }>('/admin/benefits', hotelHeaders(hotelId)),

  updateBenefits: (hotelId: string, benefits: string[]) =>
    bookingApiClient.put<{ benefits: string[] }>('/admin/benefits', { benefits }, hotelHeaders(hotelId)),

  // Promo Codes
  listPromoCodes: (hotelId: string) =>
    bookingApiClient.get<PromoCodeItem[]>('/admin/promo-codes', hotelHeaders(hotelId)),

  createPromoCode: (hotelId: string, data: Omit<PromoCodeItem, 'id' | 'useCount' | 'createdAt'>) =>
    bookingApiClient.post<PromoCodeItem>('/admin/promo-codes', data, hotelHeaders(hotelId)),

  updatePromoCode: (hotelId: string, id: string, data: Partial<PromoCodeItem>) =>
    bookingApiClient.patch<PromoCodeItem>(`/admin/promo-codes/${id}`, data, hotelHeaders(hotelId)),

  deletePromoCode: (hotelId: string, id: string) =>
    bookingApiClient.delete(`/admin/promo-codes/${id}`, hotelHeaders(hotelId)),
}
