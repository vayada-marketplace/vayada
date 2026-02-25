'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { MagnifyingGlassIcon, ArrowLeftIcon } from '@heroicons/react/24/outline'
import { bookingSettingsService, type SuperAdminHotel } from '@/services/booking'

export default function HotelsPage() {
  const router = useRouter()
  const [hotels, setHotels] = useState<SuperAdminHotel[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    bookingSettingsService.listAllHotels()
      .then(setHotels)
      .catch((err) => {
        console.error('Failed to load hotels:', err)
        setError('Failed to load hotels. Please check your connection and try again.')
      })
      .finally(() => setLoading(false))
  }, [])

  const filtered = hotels.filter((h) => {
    const q = search.toLowerCase()
    return (
      h.name.toLowerCase().includes(q) ||
      (h.location || '').toLowerCase().includes(q) ||
      h.owner_name.toLowerCase().includes(q) ||
      h.owner_email.toLowerCase().includes(q)
    )
  })

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push('/dashboard')}
                className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100 transition-colors"
              >
                <ArrowLeftIcon className="w-5 h-5" />
              </button>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Hotels</h1>
                <p className="text-sm text-gray-600">Browse and configure hotel booking engines</p>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="px-4 sm:px-6 lg:px-8 py-8 max-w-6xl mx-auto">
        {/* Search */}
        <div className="mb-6 bg-white p-4 rounded-lg shadow">
          <div className="relative">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="Search by hotel name, location, owner..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent placeholder-gray-400"
            />
          </div>
        </div>

        {error && (
          <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <p className="text-sm text-yellow-800">{error}</p>
          </div>
        )}

        {/* Table */}
        {loading ? (
          <div className="text-center py-12 bg-white rounded-lg shadow">
            <p className="text-gray-600">Loading hotels...</p>
          </div>
        ) : hotels.length === 0 && !error ? (
          <div className="text-center py-12 bg-white rounded-lg shadow">
            <h3 className="mt-2 text-sm font-medium text-gray-900">No hotels found</h3>
            <p className="mt-1 text-sm text-gray-500">No hotels are registered on the platform yet.</p>
          </div>
        ) : (
          <>
            <div className="bg-white shadow overflow-hidden sm:rounded-lg">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Hotel
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Location
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Owner
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Email
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-8 text-center text-sm text-gray-500">
                        {search ? 'No hotels match your search.' : 'No hotels found.'}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((hotel) => (
                      <tr key={hotel.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <p className="text-sm font-medium text-gray-900">{hotel.name}</p>
                          <p className="text-xs text-gray-500">{hotel.slug}</p>
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {hotel.location}{hotel.country ? `, ${hotel.country}` : ''}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">{hotel.owner_name}</td>
                        <td className="px-6 py-4 text-sm text-gray-600">{hotel.owner_email}</td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={() => router.push(`/dashboard/hotels/${hotel.id}`)}
                            className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-primary-600 bg-primary-50 border border-primary-200 rounded-md hover:bg-primary-100 transition-colors"
                          >
                            Configure
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-xs text-gray-400">
              {filtered.length} of {hotels.length} hotels
            </p>
          </>
        )}
      </div>
    </div>
  )
}
