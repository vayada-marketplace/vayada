export interface Hotel {
  id: string
  name: string
  slug: string
  description: string
  location: string
  country: string
  starRating: number
  currency: string
  heroImage: string
  images: string[]
  amenities: string[]
  checkInTime: string
  checkOutTime: string
}

export interface RoomType {
  id: string
  name: string
  description: string
  shortDescription: string
  maxOccupancy: number
  size: number
  baseRate: number
  currency: string
  amenities: string[]
  images: string[]
  bedType: string
  remainingRooms: number
  features: string[]
}

export interface AvailableRoom extends RoomType {
  nightlyRate: number
  totalPrice: number
  nights: number
}

export interface GuestDetails {
  firstName: string
  lastName: string
  email: string
  phone: string
  country: string
  specialRequests: string
}

export interface SearchParams {
  checkIn: string
  checkOut: string
  adults: number
  children: number
  rooms: number
}

export interface PromoCode {
  code: string
  discountType: 'percentage' | 'fixed'
  discountValue: number
  minNights?: number
  minAmount?: number
  description: string
}

export interface CreatorCode {
  code: string
  creatorName: string
  valid: boolean
}

export interface Booking {
  id: string
  bookingReference: string
  hotelName: string
  roomName: string
  guestName: string
  guestEmail: string
  checkIn: string
  checkOut: string
  nights: number
  adults: number
  children: number
  subtotal: number
  discount: number
  total: number
  currency: string
  promoCode?: string
  creatorCode?: string
  status: 'confirmed' | 'pending' | 'cancelled'
  createdAt: string
}

export type BookingStep = 'rooms' | 'addons' | 'details' | 'payment'
