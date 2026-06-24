/** @type {import('next').NextConfig} */ // VAY-423 e2e deploy test
const path = require("path");
const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
  output: "standalone",
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
};

module.exports = nextConfig;
