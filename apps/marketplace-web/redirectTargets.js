// Where the retired Marketplace addresses forward (VAY-2270). Shared by next.config.js and the
// app, so plain JS. Hotels continue in Booking Admin; everything else goes to vayada.com.
const trimSlash = (value) => value.replace(/\/+$/, "");

const bookingAdminUrl = trimSlash(
  process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "https://next-booking-admin.vayada.com",
);
const marketingUrl = trimSlash(process.env.NEXT_PUBLIC_MARKETING_URL || "https://vayada.com");

module.exports = { bookingAdminUrl, marketingUrl };
