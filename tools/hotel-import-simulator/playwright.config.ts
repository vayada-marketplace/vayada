import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "flow.spec.ts",
  workers: 1,
  use: {
    baseURL: process.env.IMPORT_SIMULATOR_URL ?? "https://pms.localhost:1379",
    ignoreHTTPSErrors: true,
  },
  reporter: "list",
});
