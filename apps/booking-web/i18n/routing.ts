import { BOOKING_GUEST_LANGUAGE_CODES } from "@vayada/locale-constants";
import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: BOOKING_GUEST_LANGUAGE_CODES,
  defaultLocale: "en",
  localePrefix: "as-needed",
  localeDetection: false,
  localeCookie: false,
});
