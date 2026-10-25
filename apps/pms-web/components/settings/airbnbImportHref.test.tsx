import { afterEach, expect, it, vi } from "vitest";
import { airbnbImportHref } from "./airbnbImportHref";
const id = "10090000-0000-4000-8000-000000000001";
afterEach(() => {
  vi.unstubAllEnvs();
});
it("is off by default", () => {
  vi.stubEnv("NEXT_PUBLIC_AIRBNB_IMPORT_ENABLED", "");
  expect(airbnbImportHref(id)).toBeNull();
});
it("opens authentication with the selected property as its return destination", () => {
  vi.stubEnv("NEXT_PUBLIC_AIRBNB_IMPORT_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_BOOKING_ADMIN_URL", "https://admin.booking.localhost:1382");
  const url = new URL(airbnbImportHref(id)!);
  expect(url.origin).toBe("https://admin.booking.localhost:1382");
  expect(url.pathname).toBe("/login");
  expect(url.searchParams.get("returnTo")).toBe(`/setup/airbnb-connect/${id}`);
});
it.each(["http://other.test", "javascript:alert(1)", "invalid", "https://user:pass@other.test"])(
  "is off for invalid configuration %s",
  (origin) => {
    vi.stubEnv("NEXT_PUBLIC_AIRBNB_IMPORT_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_BOOKING_ADMIN_URL", origin);
    expect(airbnbImportHref(id)).toBeNull();
  },
);
it("does not build a link without a canonical property", () => {
  vi.stubEnv("NEXT_PUBLIC_AIRBNB_IMPORT_ENABLED", "true");
  expect(airbnbImportHref("invalid")).toBeNull();
});

it.each([undefined, ""])("is off without a configured Booking Admin origin: %s", (origin) => {
  vi.stubEnv("NEXT_PUBLIC_AIRBNB_IMPORT_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_BOOKING_ADMIN_URL", origin);
  expect(airbnbImportHref(id)).toBeNull();
});
