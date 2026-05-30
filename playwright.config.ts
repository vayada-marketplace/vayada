import { defineConfig, devices } from "@playwright/test";

const startServers = process.env.CI === "true" || process.env.E2E_START_SERVERS === "1";

const landingBaseURL =
  process.env.E2E_LANDING_BASE_URL ||
  process.env.E2E_BASE_URL ||
  (startServers ? "http://127.0.0.1:3006" : "https://landing.localhost");

const bookingBaseURL =
  process.env.E2E_BOOKING_BASE_URL ||
  (startServers
    ? "http://hotel-alpenrose.booking.localhost:3002"
    : "https://hotel-alpenrose.booking.localhost");

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html"]],
  use: {
    actionTimeout: 10_000,
    trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
  webServer: startServers
    ? [
        {
          command: "PORT=3006 npm run dev:landing",
          url: "http://127.0.0.1:3006",
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          command: "PORT=3002 npm run dev:booking-web",
          url: "http://127.0.0.1:3002",
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ]
    : undefined,
  projects: [
    {
      name: "landing-chromium",
      testMatch: /landing\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: landingBaseURL,
      },
    },
    {
      name: "booking-web-chromium",
      testMatch: /booking-web\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: bookingBaseURL,
      },
    },
  ],
});
