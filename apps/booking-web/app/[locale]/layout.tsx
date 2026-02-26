import { NextIntlClientProvider, hasLocale } from 'next-intl'
import { getMessages, setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { headers } from 'next/headers'
import { routing } from '@/i18n/routing'
import Providers from './providers'

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
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
  const parts = hostname.split('.')
  const slug = (parts.length >= 3 && parts[0] !== 'www' ? parts[0] : null)
    || (parts.length === 2 && !parts[0].includes('localhost') ? parts[0] : null)
    || process.env.NEXT_PUBLIC_HOTEL_SLUG
    || 'hotel-alpenrose'

  return (
    <html lang={locale}>
      <body className="font-body">
        <NextIntlClientProvider messages={messages}>
          <Providers locale={locale} slug={slug}>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
