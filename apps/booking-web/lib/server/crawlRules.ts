const PRIVATE_CRAWL_PATHS = [
  "/addons",
  "/book",
  "/booking",
  "/booking-status",
  "/checkout",
  "/confirmation",
  "/my-booking",
  "/payment",
] as const;

export function publicAllowRules(locales: readonly string[]): string[] {
  return ["/", ...locales.map((locale) => `/${locale}`)];
}

// VAY-2462: a stay's checkout and bookings on its agency's address.
const PRIVATE_STAY_PATHS = ["/book", "/booking", "/confirmation", "/my-booking"] as const;

export function privateDisallowRules(locales: readonly string[]): string[] {
  return [...PRIVATE_CRAWL_PATHS, ...PRIVATE_STAY_PATHS.map((path) => `/stays/*${path}`)].flatMap(
    (path) => [
      path,
      `${path}/`,
      ...locales.flatMap((locale) => [`/${locale}${path}`, `/${locale}${path}/`]),
    ],
  );
}
