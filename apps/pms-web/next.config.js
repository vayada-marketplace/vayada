/** @type {import('next').NextConfig} */
const path = require("path");
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1"],
  transpilePackages: ["@vayada/feature-hub"],
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
};

module.exports = nextConfig;
