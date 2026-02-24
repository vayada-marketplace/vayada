'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { authService } from '@/services/auth'
import { settingsService, SuperAdminHotel } from '@/services/settings'

export default function ManageHotelsPage() {
  const router = useRouter()
  const [hotels, setHotels] = useState<SuperAdminHotel[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!authService.isSuperAdmin()) {
      router.replace('/')
      return
    }
    settingsService.listAllHotels()
      .then(setHotels)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [router])

  const filtered = hotels.filter((h) => {
    const q = search.toLowerCase()
    return (
      h.name.toLowerCase().includes(q) ||
      (h.location || '').toLowerCase().includes(q) ||
      h.owner_name.toLowerCase().includes(q) ||
      h.owner_email.toLowerCase().includes(q)
    )
  })

  function handleConfigure(hotel: SuperAdminHotel) {
    localStorage.setItem('selectedHotelId', hotel.id)
    router.push('/design-studio')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
      </div>
    )
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Manage Hotels</h1>
        <p className="text-sm text-gray-500 mt-1">
          Browse and configure any hotel on the platform.
        </p>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          placeholder="Search by hotel name, location, owner..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent placeholder-gray-400"
        />
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Hotel</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Location</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Owner</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Email</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-500">
                  {search ? 'No hotels match your search.' : 'No hotels found.'}
                </td>
              </tr>
            ) : (
              filtered.map((hotel) => (
                <tr key={hotel.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-gray-900">{hotel.name}</p>
                    <p className="text-xs text-gray-500">{hotel.slug}</p>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {hotel.location}{hotel.country ? `, ${hotel.country}` : ''}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">{hotel.owner_name}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">{hotel.owner_email}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleConfigure(hotel)}
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
    </div>
  )
}
