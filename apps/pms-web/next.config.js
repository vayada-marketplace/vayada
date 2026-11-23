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
  async headers() {
    return [
      // VAY-2516: no other site may frame any page (a hidden click on a Yes). Enforced here because
      // frame-ancestors does nothing in the report-only policy the proxy sends.
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1", ...(authPublicHostname ? [authPublicHostname] : [])],
  transpilePackages: ["@vayada/assistant-ui", "@vayada/feature-hub", "@vayada/web-security"],
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
};

module.exports = nextConfig;
