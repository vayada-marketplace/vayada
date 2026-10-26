/** @type {import('next').NextConfig} */
const path = require("path");
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
  // VAY-2260: the Marketplace pages are gone; indexed links land on the home page.
  async redirects() {
    return ["/hotel-creator-network", "/creator-benefits", "/hotel-benefits"].map((source) => ({
      source,
      destination: "/",
      permanent: true,
    }));
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "api.vayada.com",
      },
      {
        protocol: "https",
        hostname: "**.amazonaws.com",
      },
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
      {
        protocol: "http",
        hostname: "localhost",
      },
    ],
  },
};

module.exports = nextConfig;
