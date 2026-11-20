/** @type {import('next').NextConfig} */
const path = require("path");
const authPublicHostname = (() => {
  try {
    return process.env.AUTH_PUBLIC_ORIGIN ? new URL(process.env.AUTH_PUBLIC_ORIGIN).hostname : null;
  } catch {
    return null;
  }
})();
const nextConfig = {
  reactStrictMode: true,
  // Provider callback queries contain a single-use correlation token (Airbnb import, VAY-2262).
  logging: { incomingRequests: { ignore: [/^\/setup\/airbnb-return(?:\/|\?|$)/] } },
  async headers() {
    return [
      // VAY-2436: a partner app's approval page must never sit in another site's frame (a hidden
      // "Allow" click), and its address carries the app's one-time request.
      {
        source: "/partner/oauth/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
      {
        source: "/setup/airbnb-return/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
    ];
  },
  allowedDevOrigins: [
    "127.0.0.1",
    "admin.booking.localhost",
    ...(authPublicHostname ? [authPublicHostname] : []),
  ],
  output: "standalone",
  transpilePackages: ["@vayada/feature-hub"],
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
};

module.exports = nextConfig;
