import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "product-pages.spec.ts",
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: { actionTimeout: 20_000, ignoreHTTPSErrors: true, trace: "retain-on-failure" },
});
