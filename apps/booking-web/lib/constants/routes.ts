export const ROUTES = {
  HOME: '/',
  ROOMS: '/rooms',
  AVAILABILITY: '/availability',
  BOOK: '/book',
  BOOKING_CONFIRMATION: (reference: string) => `/booking/${reference}`,
  MY_BOOKING: '/my-booking',
} as const
