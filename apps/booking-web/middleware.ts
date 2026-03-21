import createMiddleware from 'next-intl/middleware'
import { NextRequest, NextResponse } from 'next/server'
import { routing } from './i18n/routing'

const intlMiddleware = createMiddleware(routing)

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8001'

function isKnownSubdomain(hostname: string): boolean {
  // Matches *.booking.vayada.com or *.localhost (local dev)
  return hostname.endsWith('.booking.vayada.com') || hostname.includes('localhost')
}

export default async function middleware(request: NextRequest) {
  const response = intlMiddleware(request)

  const hostname = request.headers.get('host') || ''
  const parts = hostname.split('.')

  let slug: string | null = null

  if (isKnownSubdomain(hostname)) {
    // Existing behavior: extract slug from subdomain
    if (parts.length >= 3 && parts[0] !== 'www') {
      slug = parts[0]
    } else if (parts.length === 2 && !parts[0].includes('localhost')) {
      slug = parts[0]
    }
  } else {
    // Custom domain: resolve slug via API
    try {
      const res = await fetch(`${API_URL}/api/resolve-domain?domain=${encodeURIComponent(hostname.split(':')[0])}`)
      if (res.ok) {
        const data = await res.json()
        slug = data.slug
      }
    } catch {
      // Resolution failed — slug stays null
    }
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
