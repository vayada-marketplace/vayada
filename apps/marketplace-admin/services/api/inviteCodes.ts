import { apiClient } from './client'

export interface InviteCode {
  id: string
  code: string
  status: 'pending' | 'redeemed' | 'expired'
  created_at: string
  expires_at: string
  hotel_name: string | null
  redeemed_at: string | null
  setup_data?: InviteData
}

export interface InviteData {
  property: {
    property_name: string
    city: string
    country: string
    address: string
    reservation_email: string
    phone_number: string
    whatsapp_number: string
    instagram: string
    facebook: string
    twitter?: string
    youtube?: string
    default_currency: string
    default_language: string
    supported_currencies: string[]
    supported_languages: string[]
  }
  branding: {
    hero_image: string
    primary_color: string
    accent_color: string
    font_pairing: string
    description: string
    booking_filters: string[]
  }
  rooms: Array<{
    name: string
    beds: Array<{ type: string; count: number }>
    maxOccupancy: number
    bedrooms: number
    bathrooms: number
    roomSize: string
    totalRooms: number
    description: string
    category: string
    baseRate: string
    nonRefundableRate: string
    nonRefundableDiscount: number
    flexibleRateEnabled: boolean
    nonRefundableEnabled: boolean
    cancellationPolicy: string
    currency: string
    images: string[]
    amenities: string[]
    features: string[]
    operatingPeriods: Array<{ from: string; to: string }>
    seasons: Array<{ name: string; tier: string; from: string; to: string; rate: string; minStay: number }>
    weekendSurcharge: string
  }>
  internal?: {
    active_plan: 'commission' | 'fixed'
    commission_rate: number
    fixed_monthly_fee: number
    payment_provider?: 'stripe' | 'xendit'
  }
  addons?: Array<{
    name: string
    description: string
    price: number
    currency: string
    category: string
    image: string
    duration?: string
    perPerson: boolean
    perNight: boolean
  }>
  benefits?: string[]
  policies: {
    check_in_time: string
    check_out_time: string
    pay_at_property: boolean
    online_card_payment: boolean
    bank_transfer: boolean
    special_requests: boolean
    arrival_time: boolean
    guest_count: boolean
    refer_a_guest: boolean
  }
}

export const inviteCodesService = {
  async list(): Promise<InviteCode[]> {
    return apiClient.get<InviteCode[]>('/admin/invite-codes')
  },

  async create(data: InviteData): Promise<InviteCode> {
    return apiClient.post<InviteCode>('/admin/invite-codes', { data })
  },

  async delete(id: string): Promise<void> {
    return apiClient.delete(`/admin/invite-codes/${id}`)
  },
}
