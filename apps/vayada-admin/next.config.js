/** @type {import('next').NextConfig} */
const path = require("path");
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
};

module.exports = nextConfig;
