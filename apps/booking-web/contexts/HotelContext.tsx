'use client'

import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { Hotel, RoomType, Addon } from '@/lib/types'
import { hotelService } from '@/services/api/hotel'
import { generateColorPalette } from '@/lib/utils/colors'

const FONT_PAIRINGS: Record<string, { heading: string; body: string; googleFamilies: string[] }> = {
  'high-end-serif': {
    heading: "'Playfair Display', serif",
    body: "'Source Sans Pro', sans-serif",
    googleFamilies: ['Playfair+Display:ital,wght@0,400;0,700;1,400', 'Source+Sans+Pro:wght@300;400;600;700'],
  },
  'modern-minimalist': {
    heading: "'Inter', sans-serif",
    body: "'Inter', sans-serif",
    googleFamilies: ['Inter:wght@300;400;500;600;700'],
  },
  'grand-classic': {
    heading: "'Lora', serif",
    body: "'Source Sans Pro', sans-serif",
    googleFamilies: ['Lora:ital,wght@0,400;0,700;1,400', 'Source+Sans+Pro:wght@300;400;600;700'],
  },
}

interface HotelContextValue {
  hotel: Hotel | null
  rooms: RoomType[]
  addons: Addon[]
  loading: boolean
  roomsLoading: boolean
  error: string | null
  locale: string
  slug: string
  refetchRooms: (checkIn?: string, checkOut?: string, adults?: number) => Promise<void>
}

const HotelContext = createContext<HotelContextValue>({
  hotel: null,
  rooms: [],
  addons: [],
  loading: true,
  roomsLoading: false,
  error: null,
  locale: 'en',
  slug: '',
  refetchRooms: async () => {},
})

// Resolve the active hotel slug. In production this is fixed at build time
// via NEXT_PUBLIC_HOTEL_SLUG (one frontend deployment per hotel, usually on
// a dedicated domain/subdomain). For local development we let the slug be
// overridden at runtime so a single dev container can serve any hotel:
//   1. `?slug=<name>` query param (also persisted to localStorage)
//   2. `dev-hotel-slug` localStorage key
//   3. NEXT_PUBLIC_HOTEL_SLUG env var
//   4. hardcoded fallback
const DEV_SLUG_STORAGE_KEY = 'dev-hotel-slug'

function resolveSlug(slugProp?: string): string {
  if (slugProp) return slugProp
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search)
    const querySlug = params.get('slug')
    if (querySlug) {
      try { localStorage.setItem(DEV_SLUG_STORAGE_KEY, querySlug) } catch {}
      return querySlug
    }
    try {
      const stored = localStorage.getItem(DEV_SLUG_STORAGE_KEY)
      if (stored) return stored
    } catch {}
  }
  return process.env.NEXT_PUBLIC_HOTEL_SLUG || 'hotel-alpenrose'
}

export function HotelProvider({ children, locale = 'en', slug: slugProp }: { children: ReactNode; locale?: string; slug?: string }) {
  // Resolve once on mount so server and first client render match; subsequent
  // changes (e.g. via ?slug=) update via the state setter below.
  const [slug, setSlug] = useState<string>(
    () => slugProp || process.env.NEXT_PUBLIC_HOTEL_SLUG || 'hotel-alpenrose'
  )
  useEffect(() => {
    const resolved = resolveSlug(slugProp)
    if (resolved !== slug) setSlug(resolved)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugProp])
  const [hotel, setHotel] = useState<Hotel | null>(null)
  const [rooms, setRooms] = useState<RoomType[]>([])
  const [addons, setAddons] = useState<Addon[]>([])
  const [loading, setLoading] = useState(true)
  const [roomsLoading, setRoomsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    Promise.all([
      hotelService.getHotel(slug, locale),
      hotelService.getRooms(slug),
      hotelService.getAddons(slug).catch(() => [] as Addon[]),
    ])
      .then(([hotelData, roomsData, addonsData]) => {
        setHotel(hotelData)
        setRooms(roomsData)
        setAddons(addonsData)
        setLoading(false)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load hotel data')
        setLoading(false)
      })
  }, [locale, slug])

  const refetchRooms = async (checkIn?: string, checkOut?: string, adults?: number) => {
    setRoomsLoading(true)
    try {
      const roomsData = await hotelService.getRooms(slug, checkIn, checkOut, adults)
      setRooms(roomsData)
    } catch (err) {
      console.error('Failed to refetch rooms', err)
    } finally {
      setRoomsLoading(false)
    }
  }

  // Apply branding colors as CSS variables
  useEffect(() => {
    if (hotel?.branding?.primaryColor) {
      const palette = generateColorPalette(hotel.branding.primaryColor)
      const root = document.documentElement
      for (const [shade, color] of Object.entries(palette)) {
        root.style.setProperty(`--color-primary-${shade}`, color)
      }
    }
  }, [hotel?.branding?.primaryColor])

  // Apply accent color (card/section backgrounds)
  useEffect(() => {
    if (hotel?.branding?.accentColor) {
      document.documentElement.style.setProperty('--color-accent', hotel.branding.accentColor)
    }
  }, [hotel?.branding?.accentColor])

  // Apply branding font pairing as CSS variables + load Google Fonts
  useEffect(() => {
    const pairingId = hotel?.branding?.fontPairing
    if (pairingId && FONT_PAIRINGS[pairingId]) {
      const { heading, body, googleFamilies } = FONT_PAIRINGS[pairingId]
      const root = document.documentElement
      root.style.setProperty('--font-heading', heading)
      root.style.setProperty('--font-body', body)

      // Load Google Fonts
      const linkId = 'branding-fonts'
      let link = document.getElementById(linkId) as HTMLLinkElement | null
      if (!link) {
        link = document.createElement('link')
        link.id = linkId
        link.rel = 'stylesheet'
        document.head.appendChild(link)
      }
      const families = googleFamilies.join('&family=')
      link.href = `https://fonts.googleapis.com/css2?family=${families}&display=swap`
    }
  }, [hotel?.branding?.fontPairing])

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <div className="bg-white rounded-2xl border border-red-200 shadow-sm p-8 max-w-md w-full text-center">
          <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-gray-900 mb-2">Unable to Load Hotel</h2>
          <p className="text-sm text-gray-600 mb-4">
            We couldn&apos;t fetch the hotel data. Please try again later.
          </p>
          <div className="bg-red-50 rounded-lg p-3 mb-6">
            <p className="text-sm text-red-700 font-mono break-all">{error}</p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-2.5 bg-gray-900 text-white font-semibold rounded-full hover:bg-gray-800 transition-colors text-sm"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="animate-spin w-8 h-8 border-4 border-gray-200 border-t-gray-900 rounded-full" />
      </div>
    )
  }

  return (
    <HotelContext.Provider value={{ hotel, rooms, addons, loading, roomsLoading, error, locale, slug, refetchRooms }}>
      {children}
    </HotelContext.Provider>
  )
}

export function useHotel() {
  const { hotel, loading, error } = useContext(HotelContext)
  return { hotel: hotel!, loading, error }
}

export function useRooms() {
  const { rooms, loading, roomsLoading, error, refetchRooms } = useContext(HotelContext)
  return { rooms, loading, roomsLoading, error, refetchRooms }
}

export function useAddons() {
  const { addons, loading, error } = useContext(HotelContext)
  return { addons, loading, error }
}

export function useSlug() {
  const { slug } = useContext(HotelContext)
  return { slug }
}
