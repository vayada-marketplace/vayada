// Which hotel site answers which host. Kept apart from the content so the middleware doesn't bundle
// photos and fonts. Every site answers on `<slug>.site.vayada.com` (and `<slug>.site.localhost` in
// development); a hotel's own domains are listed here once their DNS points at us.
export const SITE_HOSTS: Record<string, string[]> = {
  "animals-ahangama": [],
};

export function siteSlugForHost(host: string): string | null {
  const hostname = host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  for (const [slug, domains] of Object.entries(SITE_HOSTS)) {
    if (
      hostname === `${slug}.site.vayada.com` ||
      hostname === `${slug}.site.localhost` ||
      domains.includes(hostname)
    ) {
      return slug;
    }
  }
  return null;
}
