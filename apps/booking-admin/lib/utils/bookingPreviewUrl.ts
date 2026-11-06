type PreviewLocation = Pick<Location, "protocol" | "hostname" | "port">;

export function buildBookingPreviewUrl(input: {
  slug: string;
  template?: string;
  location?: PreviewLocation;
}): string | null {
  const slug = input.slug.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) return null;

  const template = input.template?.trim();
  if (template?.includes("{slug}")) return template.replaceAll("{slug}", slug);

  const location = input.location;
  if (location?.hostname === "localhost") {
    return `${location.protocol === "https:" ? "https:" : "http:"}//${slug}.localhost:3002`;
  }
  if (location?.hostname.endsWith(".localhost")) {
    const protocol = location.protocol === "http:" ? "http:" : "https:";
    const port = location.port ? `:${location.port}` : "";
    return `${protocol}//${slug}.booking.localhost${port}`;
  }

  // The new system's booking pages (VAY-2483): `*.booking.vayada.com` is still the old system, which
  // knows none of its hotels or agency pages.
  return `https://${slug}.next-booking.vayada.com`;
}
