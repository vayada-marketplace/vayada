'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { MagnifyingGlassIcon, ArrowLeftIcon } from '@heroicons/react/24/outline'
import { bookingSettingsService, type SuperAdminHotel } from '@/services/booking'
import { usersService } from '@/services/api'

interface HotelRow {
  id: string
  name: string
  slug: string
  location: string
  country: string
  owner_name: string
  owner_email: string
  /** marketplace user ID — present for uninitialized hotels */
  marketplace_user_id?: string
  /** true when a booking_hotels row already exists */
  initialized: boolean
}

export default function HotelsPage() {
  const router = useRouter()
  const [hotels, setHotels] = useState<HotelRow[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [settingUp, setSettingUp] = useState<string | null>(null)

  useEffect(() => {
    loadHotels()
  }, [])

  const loadHotels = async () => {
    try {
      setLoading(true)
      setError('')

      // Fetch both sources in parallel
      const [bookingHotels, marketplaceRes] = await Promise.all([
        bookingSettingsService.listAllHotels().catch(() => [] as SuperAdminHotel[]),
        usersService.getAllUsers({ type: 'hotel', page: 1, page_size: 500 }),
      ])

      // Build a set of marketplace user emails that already have a booking hotel
      const initializedEmails = new Set(
        bookingHotels.map((h) => h.owner_email.toLowerCase()),
      )

      // Start with all booking hotels (already initialized)
      const rows: HotelRow[] = bookingHotels.map((h) => ({
        ...h,
        initialized: true,
      }))

      // Add marketplace hotel users that are NOT yet in booking_hotels
      for (const user of marketplaceRes.users || []) {
        if (!initializedEmails.has(user.email.toLowerCase())) {
          rows.push({
            id: user.id,
            name: user.name,
            slug: '',
            location: '',
            country: '',
            owner_name: user.name,
            owner_email: user.email,
            marketplace_user_id: user.id,
            initialized: false,
          })
        }
      }

      setHotels(rows)
    } catch (err) {
      console.error('Failed to load hotels:', err)
      setError('Failed to load hotels. Please check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleSetup = async (row: HotelRow) => {
    if (!row.marketplace_user_id) return
    try {
      setSettingUp(row.marketplace_user_id)
      const created = await bookingSettingsService.createHotelForUser(
        row.marketplace_user_id,
        row.name,
      )
      router.push(`/dashboard/hotels/${created.id}`)
    } catch (err) {
      console.error('Failed to create hotel:', err)
      setError('Failed to initialize hotel. Please try again.')
    } finally {
      setSettingUp(null)
    }
  }

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
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-8 text-center text-sm text-gray-500">
                        {search ? 'No hotels match your search.' : 'No hotels found.'}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((hotel) => (
                      <tr key={hotel.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-6 py-4">
                          <p className="text-sm font-medium text-gray-900">{hotel.name}</p>
                          {hotel.slug && <p className="text-xs text-gray-500">{hotel.slug}</p>}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">
                          {hotel.location || hotel.country
                            ? `${hotel.location}${hotel.country ? `, ${hotel.country}` : ''}`
                            : <span className="text-gray-400">-</span>}
                        </td>
                        <td className="px-6 py-4 text-sm text-gray-600">{hotel.owner_name}</td>
                        <td className="px-6 py-4 text-sm text-gray-600">{hotel.owner_email}</td>
                        <td className="px-6 py-4">
                          {hotel.initialized ? (
                            <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-green-100 text-green-800">
                              Active
                            </span>
                          ) : (
                            <span className="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-gray-100 text-gray-600">
                              Not set up
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right">
                          {hotel.initialized ? (
                            <button
                              onClick={() => router.push(`/dashboard/hotels/${hotel.id}`)}
                              className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-primary-600 bg-primary-50 border border-primary-200 rounded-md hover:bg-primary-100 transition-colors"
                            >
                              Configure
                            </button>
                          ) : (
                            <button
                              onClick={() => handleSetup(hotel)}
                              disabled={settingUp === hotel.marketplace_user_id}
                              className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-white bg-primary-600 border border-primary-600 rounded-md hover:bg-primary-700 transition-colors disabled:opacity-50"
                            >
                              {settingUp === hotel.marketplace_user_id ? 'Setting up...' : 'Set Up'}
                            </button>
                          )}
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
