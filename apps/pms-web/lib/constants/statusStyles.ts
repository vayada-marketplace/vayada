export const BOOKING_STATUS_STYLES: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  confirmed: "bg-green-100 text-green-700",
  cancelled: "bg-red-100 text-red-600",
  expired: "bg-gray-100 text-gray-600",
};

export const PAYMENT_STATUS_STYLES: Record<string, string> = {
  unpaid: "bg-gray-100 text-gray-600",
  authorized: "bg-blue-100 text-blue-700",
  captured: "bg-green-100 text-green-700",
  cancelled: "bg-red-100 text-red-600",
  refunded: "bg-purple-100 text-purple-700",
  partially_refunded: "bg-purple-100 text-purple-700",
  failed: "bg-red-100 text-red-600",
  pay_at_property: "bg-amber-100 text-amber-700",
};

export function getPaymentStatusLabel(status: string | null | undefined): string {
  if (!status) return "";
  const labels: Record<string, string> = {
    unpaid: "Unpaid",
    authorized: "Authorized",
    captured: "Paid",
    cancelled: "Cancelled",
    refunded: "Refunded",
    partially_refunded: "Partially refunded",
    failed: "Failed",
    pay_at_property: "Will pay at property",
  };
  if (labels[status]) return labels[status];
  const spaced = status.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Alias -> canonical key. Channex sends ``ota_name`` in many forms
// (``Booking.com`` / ``booking_com`` / ``BookingCom`` / ``booking``);
// the backend normalizes new writes (see ``app/channels.py``) but the
// frontend keeps the same alias table as defense-in-depth so historical
// rows (pre-VAY-350) and any unexpected casing render with the right
// color/label without depending on a backfill having reached every row.
const CHANNEL_ALIASES: Record<string, string> = {
  direct: "direct",
  airbnb: "airbnb",
  booking: "booking.com",
  "booking.com": "booking.com",
  booking_com: "booking.com",
  bookingcom: "booking.com",
  expedia: "expedia",
  "expedia.com": "expedia",
  agoda: "agoda",
  vrbo: "vrbo",
  hostelworld: "hostelworld",
  tripadvisor: "tripadvisor",
  "hotels.com": "hotels.com",
  hotelscom: "hotels.com",
  channex: "channex",
  other: "other",
};

export function normalizeChannelKey(channel: string | null | undefined): string {
  if (!channel) return "other";
  const key = channel.toLowerCase().trim();
  if (!key) return "other";
  return CHANNEL_ALIASES[key] || key;
}

// Badge styles — light background + dark text. Used in lists / detail
// pages where the channel is rendered as a pill, not a solid bar.
export const CHANNEL_COLORS: Record<string, { bg: string; text: string }> = {
  direct: { bg: "bg-blue-100", text: "text-blue-700" },
  airbnb: { bg: "bg-pink-100", text: "text-pink-700" },
  booking: { bg: "bg-[#003580]/10", text: "text-[#003580]" },
  "booking.com": { bg: "bg-[#003580]/10", text: "text-[#003580]" },
  expedia: { bg: "bg-yellow-100", text: "text-yellow-700" },
  channex: { bg: "bg-gray-100", text: "text-gray-700" },
  other: { bg: "bg-gray-100", text: "text-gray-700" },
};

// Solid bar styles — used by the PMS Calendar (timeline + month + mobile)
// where the channel renders as a colored block with white text.
// Booking.com uses its brand navy (#003580) so it's visually distinct
// from the Direct blue (Vayada).
export const CHANNEL_BAR_COLORS: Record<string, string> = {
  direct: "bg-blue-500",
  airbnb: "bg-pink-500",
  "booking.com": "bg-[#003580]",
  expedia: "bg-yellow-500",
  channex: "bg-gray-500",
  other: "bg-gray-500",
};

export function getChannelBarColor(channel: string | null | undefined): string {
  return CHANNEL_BAR_COLORS[normalizeChannelKey(channel)] || CHANNEL_BAR_COLORS.other;
}

export function getChannelLabel(channel: string): string {
  const labels: Record<string, string> = {
    direct: "Direct",
    airbnb: "Airbnb",
    "booking.com": "Booking.com",
    expedia: "Expedia",
    agoda: "Agoda",
    vrbo: "Vrbo",
    hostelworld: "Hostelworld",
    tripadvisor: "Tripadvisor",
    "hotels.com": "Hotels.com",
    channex: "Channex",
    other: "Other",
  };
  return labels[normalizeChannelKey(channel)] || channel;
}
