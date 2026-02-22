import createMiddleware from 'next-intl/middleware'
import { NextRequest, NextResponse } from 'next/server'
import { routing } from './i18n/routing'

const intlMiddleware = createMiddleware(routing)

export default function middleware(request: NextRequest) {
  const response = intlMiddleware(request)

  // Extract slug from subdomain: hotel-alpenrose.booking.vayada.com -> hotel-alpenrose
  const hostname = request.headers.get('host') || ''
  const parts = hostname.split('.') // e.g. ['hotel-alpenrose', 'booking', 'vayada', 'com']

  let slug: string | null = null

  if (parts.length >= 3 && parts[0] !== 'www') {
    // Subdomain detected (e.g. hotel-alpenrose.booking.vayada.com)
    slug = parts[0]
  } else if (parts.length === 2 && !parts[0].includes('localhost')) {
    // e.g. hotel-alpenrose.localhost:3002 (local subdomain testing)
    slug = parts[0]
  }

  if (slug) {
    response.cookies.set('hotel-slug', slug, { path: '/' })
  }

  // Capture referral code from ?ref= query param → 30-day cookie
  const refCode = request.nextUrl.searchParams.get('ref')
  if (refCode) {
    response.cookies.set('ref', refCode, {
      path: '/',
      maxAge: 60 * 60 * 24 * 30, // 30 days
      sameSite: 'lax',
    })
  }

  return response
}

export const config = {
  matcher: '/((?!api|trpc|_next|_vercel|.*\\..*).*)',
}
