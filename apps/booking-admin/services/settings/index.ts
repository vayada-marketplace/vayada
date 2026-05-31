import { apiClient } from "../api/client";

export interface PropertySettings {
  // booking_hotels.id — unified across both backend databases after
  // the multi-hotel-ids migration. Populated by POST /admin/hotels
  // and by GET /admin/settings/property. Used to set selectedHotelId
  // and to pass bookingHotelId to the PMS register-hotel endpoint.
  id?: string;
  slug: string;
  property_name: string;
  reservation_email: string;
  phone_number: string;
  whatsapp_number: string;
  address: string;
  city?: string;
  country?: string;
  instagram?: string;
  facebook?: string;
  tiktok?: string;
  youtube?: string;
  default_currency: string;
  default_language?: string;
  supported_currencies: string[];
  supported_languages: string[];
  check_in_time: string;
  check_out_time: string;
  check_in_from?: string;
  check_in_until?: string;
  check_out_from?: string;
  check_out_until?: string;
  pay_at_property_enabled: boolean;
  pay_at_hotel_methods: string[];
  online_card_payment?: boolean;
  bank_transfer?: boolean;
  paypal_enabled?: boolean;
  paypal_email?: string;
  paypal_payment_window_hours?: number;
  special_requests_enabled?: boolean;
  arrival_time_enabled?: boolean;
  guest_count_enabled?: boolean;
  refer_a_guest_enabled?: boolean;
  map_view_enabled?: boolean;
  free_cancellation_days: number;
  email_notifications: boolean;
  new_booking_alerts: boolean;
  payment_alerts: boolean;
  ota_booking_alerts: boolean;
  billing_active_plan?: string;
  billing_commission_rate?: number;
  billing_fixed_fee?: number;
  billing_pending_switch?: string | null;
  billing_switch_effective_date?: string | null;
  booking_engine_fee_pct?: number;
  channel_manager_fee_pct?: number;
  affiliate_platform_fee_pct?: number;
  active_room_count?: number;
  fixed_plan_projected_monthly_fee?: number;
  payout_account_holder?: string;
  payout_account_type?: "iban" | "account_number";
  payout_iban?: string;
  payout_account_number?: string;
  payout_bank_name?: string;
  payout_swift?: string;
  terms_text?: string;
  cancellation_policy_text?: string;
  show_room_detail_map?: boolean;
  points_of_interest?: PointOfInterest[];
}

export interface PointOfInterest {
  id: string;
  label: string;
  travelTime: string;
  color: string;
  latitude: number;
  longitude: number;
  position: number;
}

export type PropertySettingsUpdate = Partial<PropertySettings>;

export interface DesignSettings {
  hero_image: string;
  hero_heading: string;
  hero_subtext: string;
  primary_color: string;
  font_pairing: string;
  booking_filters: string[];
  custom_filters: Record<string, string>;
  filter_rooms: Record<string, string[]>;
}

export type DesignSettingsUpdate = Partial<DesignSettings>;

export interface SetupPrefillData {
  property_name?: string;
  reservation_email?: string;
  phone_number?: string;
  address?: string;
  hero_image?: string;
}

export interface SetupStatusResponse {
  setup_complete: boolean;
  missing_fields: string[];
  prefill_data?: SetupPrefillData | null;
}

export interface HotelSummary {
  id: string;
  name: string;
  slug: string;
  location: string;
  country: string;
}

export interface AddonItem {
  id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  category: string;
  image: string;
  duration?: string;
  perPerson?: boolean;
  perNight?: boolean;
  location?: string;
  maxGuests?: string;
  highlights?: string[];
  includedItems?: string[];
}

export interface SuperAdminHotel extends HotelSummary {
  owner_name: string;
  owner_email: string;
  billing_active_plan: string;
  billing_pending_switch: string | null;
  billing_switch_effective_date: string | null;
  booking_engine_fee_pct: number;
  channel_manager_fee_pct: number;
  affiliate_platform_fee_pct: number;
  fixed_base_fee: number;
  fixed_rooms_included: number;
  fixed_per_extra_room_fee: number;
}

export interface HotelBillingUpdate {
  booking_engine_fee_pct?: number;
  channel_manager_fee_pct?: number;
  affiliate_platform_fee_pct?: number;
  fixed_base_fee?: number;
  fixed_rooms_included?: number;
  fixed_per_extra_room_fee?: number;
}

export interface AddonSettings {
  showAddonsStep: boolean;
  groupAddonsByCategory: boolean;
}

export interface PromoCodeItem {
  id: string;
  code: string;
  discountType: "percentage" | "fixed";
  discountValue: number;
  validFrom?: string | null;
  validUntil?: string | null;
  isActive: boolean;
  maxUses?: number | null;
  useCount: number;
  createdAt?: string;
}

export interface CustomDomainConnectResponse {
  domain: string;
  status: string;
  ssl_status: string;
}

export interface CustomDomainStatus {
  configured: boolean;
  domain?: string;
  status?: string;
  ssl_status?: string;
  verification_errors?: string[];
}

export const customDomainService = {
  connect: (domain: string) =>
    apiClient.post<CustomDomainConnectResponse>("/admin/settings/custom-domain", { domain }),

  disconnect: () => apiClient.delete<{ removed: string }>("/admin/settings/custom-domain"),

  getStatus: () => apiClient.get<CustomDomainStatus>("/admin/settings/custom-domain/status"),
};

export interface HotelDeletionImpact {
  upcomingBookingsCount: number;
  connectedChannelsCount: number;
}

export const settingsService = {
  listHotels: () => apiClient.get<HotelSummary[]>("/admin/hotels"),

  listAllHotels: () => apiClient.get<SuperAdminHotel[]>("/admin/superadmin/hotels"),

  updateHotelBilling: (hotelId: string, data: HotelBillingUpdate) =>
    apiClient.patch(`/admin/superadmin/hotels/${hotelId}/billing`, data),

  getHotelDeletionImpact: (hotelId: string) =>
    apiClient.get<HotelDeletionImpact>(`/admin/hotels/${hotelId}/deletion-impact`),

  deleteHotel: (hotelId: string) => apiClient.delete<void>(`/admin/hotels/${hotelId}`),

  getPropertySettings: () => apiClient.get<PropertySettings>("/admin/settings/property"),

  updatePropertySettings: (data: PropertySettingsUpdate) =>
    apiClient.patch<PropertySettings>("/admin/settings/property", data),

  // Explicit create endpoint for the setup wizard — unlike
  // updatePropertySettings (which silently updates the user's existing
  // hotel when no X-Hotel-Id header is present), this always creates
  // a new property and returns its id. That id must then be written
  // to localStorage.selectedHotelId so subsequent wizard calls carry
  // the correct X-Hotel-Id header.
  createHotel: (data: PropertySettingsUpdate) =>
    apiClient.post<PropertySettings>("/admin/hotels", data),

  changePassword: (current_password: string, new_password: string) =>
    apiClient.post("/auth/change-password", { current_password, new_password }),

  changeEmail: (new_email: string, password: string) =>
    apiClient.post<{ message: string; email?: string }>("/auth/change-email", {
      new_email,
      password,
    }),

  verifyEmailChange: (token: string) =>
    apiClient.post<{ message: string; email: string }>("/auth/verify-email-change", { token }),

  getDesignSettings: () => apiClient.get<DesignSettings>("/admin/settings/design"),

  updateDesignSettings: (data: DesignSettingsUpdate) =>
    apiClient.patch<DesignSettings>("/admin/settings/design", data),

  getSetupStatus: () => apiClient.get<SetupStatusResponse>("/admin/settings/setup-status"),

  listAddons: () => apiClient.get<AddonItem[]>("/admin/addons"),

  createAddon: (data: Omit<AddonItem, "id">) => apiClient.post<AddonItem>("/admin/addons", data),

  updateAddon: (id: string, data: Partial<AddonItem>) =>
    apiClient.patch<AddonItem>(`/admin/addons/${id}`, data),

  deleteAddon: (id: string) => apiClient.delete(`/admin/addons/${id}`),

  getAddonSettings: () => apiClient.get<AddonSettings>("/admin/settings/addons"),

  updateAddonSettings: (data: Partial<AddonSettings>) =>
    apiClient.patch<AddonSettings>("/admin/settings/addons", data),

  getBenefits: () => apiClient.get<{ benefits: string[] }>("/admin/benefits"),

  updateBenefits: (benefits: string[]) =>
    apiClient.put<{ benefits: string[] }>("/admin/benefits", { benefits }),

  listPromoCodes: () => apiClient.get<PromoCodeItem[]>("/admin/promo-codes"),

  createPromoCode: (data: Omit<PromoCodeItem, "id" | "useCount" | "createdAt">) =>
    apiClient.post<PromoCodeItem>("/admin/promo-codes", data),

  updatePromoCode: (id: string, data: Partial<PromoCodeItem>) =>
    apiClient.patch<PromoCodeItem>(`/admin/promo-codes/${id}`, data),

  deletePromoCode: (id: string) => apiClient.delete(`/admin/promo-codes/${id}`),
};
