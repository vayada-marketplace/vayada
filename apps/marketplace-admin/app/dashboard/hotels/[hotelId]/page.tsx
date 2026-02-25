'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import { bookingSettingsService, type SuperAdminHotel } from '@/services/booking'
import DesignStudioSection from '@/components/booking/DesignStudioSection'
import BookingFlowSection from '@/components/booking/BookingFlowSection'
import HotelSettingsSection from '@/components/booking/HotelSettingsSection'

type Section = 'design' | 'booking' | 'settings'

export default function HotelConfigPage() {
  const params = useParams()
  const router = useRouter()
  const hotelId = params.hotelId as string

  const [activeSection, setActiveSection] = useState<Section>('design')
  const [hotel, setHotel] = useState<SuperAdminHotel | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    bookingSettingsService.listAllHotels()
      .then((hotels) => {
        const found = hotels.find((h) => h.id === hotelId)
        if (found) setHotel(found)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [hotelId])

  const sections = [
    { id: 'design' as const, label: 'Design Studio' },
    { id: 'booking' as const, label: 'Booking Flow' },
    { id: 'settings' as const, label: 'Settings' },
  ]

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/dashboard/hotels')}
              className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100 transition-colors"
            >
              <ArrowLeftIcon className="w-5 h-5" />
            </button>
            <div className="flex-1">
              {/* Breadcrumb */}
              <div className="flex items-center gap-1.5 text-sm text-gray-500">
                <button onClick={() => router.push('/dashboard')} className="hover:text-gray-700">Dashboard</button>
                <span>/</span>
                <button onClick={() => router.push('/dashboard/hotels')} className="hover:text-gray-700">Hotels</button>
                <span>/</span>
                <span className="text-gray-900 font-medium">
                  {loading ? '...' : hotel?.name || 'Hotel Configuration'}
                </span>
              </div>
              <h1 className="text-xl font-bold text-gray-900 mt-0.5">
                {loading ? 'Loading...' : hotel?.name || 'Hotel Configuration'}
              </h1>
            </div>
          </div>

          {/* Section tabs */}
          <div className="mt-4 flex gap-1">
            {sections.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  activeSection === section.id
                    ? 'bg-primary-50 text-primary-700 border border-primary-200'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                }`}
              >
                {section.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 py-6" style={{ height: 'calc(100vh - 160px)' }}>
        {activeSection === 'design' && <DesignStudioSection hotelId={hotelId} />}
        {activeSection === 'booking' && <BookingFlowSection hotelId={hotelId} />}
        {activeSection === 'settings' && <HotelSettingsSection hotelId={hotelId} />}
      </div>
    </div>
  )
}
