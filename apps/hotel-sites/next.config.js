/** @type {import('next').NextConfig} */
const path = require("path");

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  // Each hotel's site answers on its own host (`<slug>.site.localhost` in development).
  allowedDevOrigins: ["127.0.0.1", "*.site.localhost"],
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
  images: {
    formats: ["image/avif", "image/webp"],
  },
};

module.exports = nextConfig;
