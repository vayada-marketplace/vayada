import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "database.spec.ts",
  workers: 1,
  use: { baseURL: "https://pms.localhost:1380", ignoreHTTPSErrors: true },
});
