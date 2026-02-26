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
  error: string | null
  locale: string
  slug: string
}

const HotelContext = createContext<HotelContextValue>({
  hotel: null,
  rooms: [],
  addons: [],
  loading: true,
  error: null,
  locale: 'en',
  slug: '',
})

export function HotelProvider({ children, locale = 'en', slug: slugProp }: { children: ReactNode; locale?: string; slug?: string }) {
  const slug = slugProp || process.env.NEXT_PUBLIC_HOTEL_SLUG || 'hotel-alpenrose'
  const [hotel, setHotel] = useState<Hotel | null>(null)
  const [rooms, setRooms] = useState<RoomType[]>([])
  const [addons, setAddons] = useState<Addon[]>([])
  const [loading, setLoading] = useState(true)
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
    <HotelContext.Provider value={{ hotel, rooms, addons, loading, error, locale, slug }}>
      {children}
    </HotelContext.Provider>
  )
}

export function useHotel() {
  const { hotel, loading, error } = useContext(HotelContext)
  return { hotel: hotel!, loading, error }
}

export function useRooms() {
  const { rooms, loading, error } = useContext(HotelContext)
  return { rooms, loading, error }
}

export function useAddons() {
  const { addons, loading, error } = useContext(HotelContext)
  return { addons, loading, error }
}

export function useSlug() {
  const { slug } = useContext(HotelContext)
  return { slug }
}
