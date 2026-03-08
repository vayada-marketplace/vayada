export const BOOKING_STATUS_STYLES: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  confirmed: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-600',
  expired: 'bg-gray-100 text-gray-600',
}

export const PAYMENT_STATUS_STYLES: Record<string, string> = {
  unpaid: 'bg-gray-100 text-gray-600',
  authorized: 'bg-blue-100 text-blue-700',
  captured: 'bg-green-100 text-green-700',
  cancelled: 'bg-red-100 text-red-600',
  refunded: 'bg-purple-100 text-purple-700',
  partially_refunded: 'bg-purple-100 text-purple-700',
  failed: 'bg-red-100 text-red-600',
  pay_at_property: 'bg-amber-100 text-amber-700',
}

export const AFFILIATE_STATUS_STYLES: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-600',
  suspended: 'bg-gray-100 text-gray-600',
}

export const PAYOUT_STATUS_STYLES: Record<string, string> = {
  scheduled: 'bg-blue-100 text-blue-700',
  processing: 'bg-yellow-100 text-yellow-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-600',
}

export const CHANNEL_COLORS: Record<string, { bg: string; text: string }> = {
  direct: { bg: 'bg-blue-100', text: 'text-blue-700' },
  airbnb: { bg: 'bg-pink-100', text: 'text-pink-700' },
  'booking.com': { bg: 'bg-indigo-100', text: 'text-indigo-700' },
  expedia: { bg: 'bg-yellow-100', text: 'text-yellow-700' },
  other: { bg: 'bg-gray-100', text: 'text-gray-700' },
}

export function getChannelLabel(channel: string): string {
  const labels: Record<string, string> = {
    direct: 'Direct',
    airbnb: 'Airbnb',
    'booking.com': 'Booking.com',
    expedia: 'Expedia',
    other: 'Other',
  }
  return labels[channel] || channel
}
