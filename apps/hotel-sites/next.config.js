/** @type {import('next').NextConfig} */
const path = require("path");

const nextConfig = {
  reactStrictMode: true,
  // Plain files, no server: `next build` writes out/, which scripts/export-sites.mjs turns into one
  // folder per hotel address under build/.
  output: "export",
  turbopack: {
    root: path.join(__dirname, "../.."),
  },
  // No image server: components/Photo.tsx names the files the export script converts each photo
  // into, and a bare <Image> (no loader) fails the build.
  images: {
    loader: "custom",
  },
};

module.exports = nextConfig;
