const configuredSlugs = new Set(
  (process.env.NEXT_PUBLIC_REPLACEMENT_PRICING_ACCEPTANCE_ALLOWED_SLUGS ?? "")
    .split(",")
    .map((slug) => slug.trim().toLowerCase())
    .filter(Boolean),
);

export function replacementPricingAcceptanceEnabled(slug: string): boolean {
  return configuredSlugs.has(slug.toLowerCase());
}
