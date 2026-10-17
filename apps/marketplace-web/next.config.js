/** @type {import('next').NextConfig} */
const path = require("path");
const { bookingAdminUrl, marketingUrl } = require("./redirectTargets");

// VAY-2270: the Marketplace app is a redirect stub until its service is removed (step 4). Every
// former route forwards, temporarily (the address is kept for three months), to Booking Admin for
// hotel pages or to vayada.com for everything else. /api/health and /auth/[...path] stay for the
// release build and the login gateway contract.
const bookingAdminPaths = [
  "/setup",
  "/setup/:path*",
  "/invite",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
];
const marketingPaths = [
  "/",
  "/closed",
  "/creators",
  "/properties",
  "/marketplace",
  "/chat",
  "/earnings",
  "/calendar",
  "/profile",
  "/profile/:path*",
  "/hotels/:path*",
];

const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
  async redirects() {
    return [
      ...bookingAdminPaths.map((source) => ({
        source,
        destination: `${bookingAdminUrl}${source}`,
        permanent: false,
      })),
      // The privacy, data export and delete-account pages live in Booking Admin's settings.
      { source: "/settings", destination: `${bookingAdminUrl}/settings/privacy`, permanent: false },
      {
        source: "/settings/:path*",
        destination: `${bookingAdminUrl}/settings/privacy`,
        permanent: false,
      },
      // Hand-off codes were issued for this surface; a fresh sign-in is the honest answer.
      { source: "/handoff", destination: `${bookingAdminUrl}/login`, permanent: false },
      { source: "/onboarding", destination: `${bookingAdminUrl}/signup`, permanent: false },
      ...marketingPaths.map((source) => ({ source, destination: marketingUrl, permanent: false })),
    ];
  },
};

module.exports = nextConfig;
