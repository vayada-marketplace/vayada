import type { Metadata } from 'next'
import { hasLocale } from 'next-intl'
import { getMessages, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import { routing } from '@/i18n/routing'
import IntlProviderClient from '@/i18n/IntlProviderClient'
import Providers from './providers'
import DomainNotConfigured from '@/components/DomainNotConfigured'
import { resolveSlugFromHost } from '@/lib/server/resolveSlug'

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
}

// VAY-394: per-hotel favicon + title so a custom-domain page tab no
// longer shows the Vayada logo on a property's own URL. Falls back to
// the Vayada brand only when no hotel can be resolved or the lookup
// fails, so this never blocks a render.
export async function generateMetadata(): Promise<Metadata> {
  const headersList = await headers()
  const hostname = headersList.get('host') || ''
  const slug = await resolveSlugFromHost(hostname)
  const fallback: Metadata = {
    title: 'Book Your Stay',
    description: 'Book your perfect hotel stay.',
    icons: { icon: [{ url: '/vayada-logo.png' }] },
  }
  if (!slug) return fallback

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8001'
  try {
    const res = await fetch(`${apiUrl}/api/hotels/${slug}`, { cache: 'no-store' })
    if (!res.ok) return fallback
    const hotel = await res.json()
    const favicon = hotel?.branding?.faviconUrl || '/vayada-logo.png'
    return {
      title: hotel?.name || 'Book Your Stay',
      description: hotel?.description || 'Book your perfect hotel stay.',
      icons: { icon: [{ url: favicon }] },
    }
  } catch {
    return fallback
  }
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  if (!hasLocale(routing.locales, locale)) {
    notFound()
  }

  setRequestLocale(locale)

  const messages = await getMessages()

  const headersList = await headers()
  const hostname = headersList.get('host') || ''
  // `undefined` is dev-only — the HotelProvider's client effect resolves
  // the slug from ?slug=/localStorage so a single dev container can
  // serve any hotel. `null` is a real production miss → render the
  // Domain Not Configured page instead of falling through to a wrong
  // hotel (see VAY-394: the previous `hotel-alpenrose` fallback caused
  // guests to see "Hotel 'hotel-alpenrose' not found" on misconfigured
  // custom domains).
  const slug = await resolveSlugFromHost(hostname)

  if (slug === null) {
    return (
      <html lang={locale}>
        <body className="font-body">
          <DomainNotConfigured hostname={hostname} />
        </body>
      </html>
    )
  }

  return (
    <html lang={locale}>
      <body className="font-body">
        <IntlProviderClient locale={locale} messages={messages}>
          <Providers locale={locale} slug={slug}>{children}</Providers>
        </IntlProviderClient>
      </body>
    </html>
  )
}
