export interface HotelContact {
  address: string;
  phone: string;
  email: string;
  whatsapp?: string;
  website?: string;
}

export interface HotelSocialLinks {
  facebook?: string;
  instagram?: string;
  tiktok?: string;
  youtube?: string;
}

export interface HotelBranding {
  heroImage?: string;
  heroHeading?: string;
  heroSubtext?: string;
  primaryColor?: string;
  accentColor?: string;
  fontPairing?: string;
  logoUrl?: string;
  faviconUrl?: string;
}

export interface HotelHeaderSettings {
  showContactButton: boolean;
  showLanguageSelector: boolean;
  showCurrencySelector: boolean;
}

export interface GuestTypeSettings {
  adultAgeThreshold: number;
  childrenEnabled: boolean;
}

export interface Hotel {
  id: string;
  name: string;
  slug: string;
  canonicalUrl: string;
  bookingBaseUrl: string;
  customDomainUrl?: string | null;
  description: string;
  location: string;
  country: string;
  starRating: number;
  currency: string;
  /** Display-only currencies a guest may switch to, the hotel currency first. */
  displayCurrencies: string[];
  /** The currency guests see first when it isn't the hotel currency (VAY-2390); display only. */
  displayDefaultCurrency?: string | null;
  /** The hero photo, else the first gallery photo; null when the hotel has no photos yet (VAY-2247). */
  heroImage: string | null;
  images: string[];
  amenities: string[];
  checkInTime: string;
  checkOutTime: string;
  checkInUntil?: string;
  checkOutFrom?: string;
  timezone?: string;
  /** The public map pin, only when the hotel shows its location (rounded when "approximate"). */
  mapPin?: { latitude: number; longitude: number };
  contact: HotelContact;
  bookingFilters: string[];
  customFilters?: Record<string, string>;
  filterRooms?: Record<string, string[]>;
  socialLinks?: HotelSocialLinks;
  branding?: HotelBranding;
  headerSettings?: HotelHeaderSettings;
  defaultLanguage: string;
  supportedLanguages: string[];
  guestTypeSettings?: GuestTypeSettings;
  instantBook?: boolean;
  /** Guests can enter a promo code: the hotel's Promos switch is on and a code is live (VAY-2200). */
  promoCodesEnabled?: boolean;
}

export type RoomSelectionLine = {
  roomTypeId: string;
  publicOfferKey: string;
  guests: { adults: number; children: number }[];
};
export type RoomSelection = {
  contractVersion: "booking-room-selection.v1";
  lines: RoomSelectionLine[];
};
export type SelectedRoomLine = RoomSelectionLine & {
  roomName: string;
  roomCount: number;
  ratePlanId?: string | null;
  rateSummary: Record<string, unknown>;
  policy: Record<string, unknown>;
  totals: Record<string, string>;
};
export interface RoomSelectionSnapshot {
  roomSelection?: RoomSelection;
  roomLines?: SelectedRoomLine[];
}
/** VAY-2320: one booked room of a pricing booking, as the guest booking view sends it. */
export type BookedRoom = {
  roomTypeId: string;
  roomName: string | null;
  mealPlan: string | null;
  adults: number;
  children: number;
  cancellation:
    | { kind: "non_refundable" }
    | { kind: "free_until_days_before_arrival"; days: number }
    | { kind: "partial_refund" }
    | null;
};
export type RoomCombination = {
  roomSelection: RoomSelection;
  roomLines: SelectedRoomLine[];
  expiresAt: string;
  totalAmount: number;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
};

export interface RoomType {
  rateMealDescriptions?: { flexible: string | null; nonrefundable: string | null };
  combination?: RoomCombination;
  id: string;
  name: string;
  category?: string;
  description: string;
  shortDescription: string;
  maxOccupancy: number;
  maxAdults?: number | null;
  maxChildren?: number | null;
  size: number;
  baseRate: number;
  nonRefundableRate: number | null;
  nightlyRates?: number[];
  nonRefundableNightlyRates?: number[];
  originalNightlyRates?: number[];
  currency: string;
  locationAddress?: string;
  latitude?: number | null;
  longitude?: number | null;
  amenities: string[];
  images: string[];
  bedType: string;
  remainingRooms: number;
  features: string[];
  benefits: string[];
  flexibleRateEnabled: boolean;
  cancellationPolicy?: string;
  flexibleCancellationType?: "free" | "partial_refund";
  partialRefundCancelWindowDays?: number;
  partialRefundAmountPercent?: number;
  partialRefundTiers?: { minDaysBeforeCheckIn: number; refundPercent: number }[];
  originalRate?: number | null;
  promotion?: { name: string; discountAmount: number; discountPercent: number };
  nonRefundablePromotion?: { name: string; discountAmount: number; discountPercent: number };
  lastMinuteDiscountPercent?: number | null;
  ratePaymentMethods?: Record<string, string[]> | null;
  rateDepositSettings?: Record<
    string,
    {
      enabled: boolean;
      percentage: number | null;
    }
  > | null;
}

export interface SearchParams {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  rooms: number;
}

export interface Booking extends RoomSelectionSnapshot {
  /** VAY-2320: every booked room, each with its own type, guests, meal and terms. */
  bookedRooms?: BookedRoom[];
  mealDescription?: string | null;
  canEditRequest?: boolean;
  id: string;
  bookingReference: string;
  hotelName: string;
  roomName: string;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  nightlyRate: number;
  // VAY-403: rooms booked in this reservation. Optional for backward
  // compatibility with cached/legacy booking shapes; treat missing as 1.
  numberOfRooms?: number;
  totalAmount: number;
  depositRequired?: boolean;
  depositPercentage?: number | null;
  depositAmount?: number;
  balanceAmount?: number;
  addonTotal?: number;
  // Selected add-ons snapshot from booking creation. Names are cached at
  // booking time so historical bookings still show the correct name even
  // if the addon is later renamed or removed.
  addonIds?: string[];
  addonNames?: string[];
  addonQuantities?: Record<string, number>;
  addonPackageQuantities?: Record<string, number>;
  addonDates?: Record<string, string[]>;
  currency: string;
  // 'draft' is the placeholder shape returned for the card-payment flow
  // before the booking row is materialized (VAY-388).
  status:
    | "confirmed"
    | "pending"
    | "cancelled"
    | "declined"
    | "expired"
    | "draft"
    | "checked_in"
    | "checked_out";
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  paymentDeadline?: string | null;
  bankTransferDetails?: string | null;
  unitNames?: string[];
  cancelledAt?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  hostResponseDeadline?: string | null;
  createdAt: string;
}

export interface Addon {
  id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  category: string;
  image: string;
  images?: string[];
  maxQuantity?: number;
  leadTime?: string;
  duration?: string;
  perPerson?: boolean;
  perNight?: boolean;
  location?: string;
  maxGuests?: string;
  highlights?: string[];
  includedItems?: string[];
}
