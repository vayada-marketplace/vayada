/**
 * Public-facing host used for affiliate referral links. In staging this
 * needs to be the staging marketplace host, not vayada.com.
 */
export const SITE_HOST =
  process.env.NEXT_PUBLIC_SITE_HOST || 'vayada.com'

export function affiliateLink(hotelSlug: string, referralCode: string): string {
  return `${hotelSlug}.${SITE_HOST}?ref=${referralCode}`
}
