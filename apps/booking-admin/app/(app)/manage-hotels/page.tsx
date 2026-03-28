'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { MagnifyingGlassIcon, PencilIcon, CheckIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { authService } from '@/services/auth'
import { settingsService, SuperAdminHotel } from '@/services/settings'

export default function ManageHotelsPage() {
  const router = useRouter()
  const [hotels, setHotels] = useState<SuperAdminHotel[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editRate, setEditRate] = useState(5)
  const [editFee, setEditFee] = useState(30)
  const [saving, setSaving] = useState(false)

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

  function startEdit(hotel: SuperAdminHotel) {
    setEditingId(hotel.id)
    setEditRate(hotel.billing_commission_rate)
    setEditFee(hotel.billing_fixed_fee)
  }

  async function saveEdit(hotelId: string) {
    setSaving(true)
    try {
      await settingsService.updateHotelBilling(hotelId, {
        billing_commission_rate: editRate,
        billing_fixed_fee: editFee,
      })
      setHotels(prev => prev.map(h => h.id === hotelId ? { ...h, billing_commission_rate: editRate, billing_fixed_fee: editFee } : h))
      setEditingId(null)
    } catch (err) {
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500" />
      </div>
    )
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Manage Hotels</h1>
        <p className="text-sm text-gray-500 mt-1">
          Browse, configure, and set billing rates for each hotel.
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
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Owner</th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Plan</th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Commission</th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Fixed Fee</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-500">
                  {search ? 'No hotels match your search.' : 'No hotels found.'}
                </td>
              </tr>
            ) : (
              filtered.map((hotel) => (
                <tr key={hotel.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-gray-900">{hotel.name}</p>
                    <p className="text-xs text-gray-500">{hotel.location}{hotel.country ? `, ${hotel.country}` : ''}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm text-gray-700">{hotel.owner_name}</p>
                    <p className="text-xs text-gray-500">{hotel.owner_email}</p>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold ${
                      hotel.billing_active_plan === 'fixed'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-green-100 text-green-700'
                    }`}>
                      {hotel.billing_active_plan === 'fixed' ? 'Fixed' : 'Commission'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {editingId === hotel.id ? (
                      <div className="flex items-center justify-center gap-1">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={0.5}
                          value={editRate}
                          onChange={(e) => setEditRate(Number(e.target.value))}
                          className="w-16 px-2 py-1 text-sm text-center border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                        <span className="text-xs text-gray-500">%</span>
                      </div>
                    ) : (
                      <span className="text-sm font-medium text-gray-900">{hotel.billing_commission_rate}%</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {editingId === hotel.id ? (
                      <div className="flex items-center justify-center gap-1">
                        <span className="text-xs text-gray-500">$</span>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={editFee}
                          onChange={(e) => setEditFee(Number(e.target.value))}
                          className="w-16 px-2 py-1 text-sm text-center border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-primary-500"
                        />
                      </div>
                    ) : (
                      <span className="text-sm font-medium text-gray-900">${hotel.billing_fixed_fee}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {editingId === hotel.id ? (
                        <>
                          <button
                            onClick={() => saveEdit(hotel.id)}
                            disabled={saving}
                            className="p-1.5 text-green-600 hover:bg-green-50 rounded-md transition-colors disabled:opacity-50"
                            title="Save"
                          >
                            <CheckIcon className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-md transition-colors"
                            title="Cancel"
                          >
                            <XMarkIcon className="w-4 h-4" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => startEdit(hotel)}
                            className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-md transition-colors"
                            title="Edit billing"
                          >
                            <PencilIcon className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleConfigure(hotel)}
                            className="inline-flex items-center px-3 py-1.5 text-xs font-medium text-primary-600 bg-primary-50 border border-primary-200 rounded-md hover:bg-primary-100 transition-colors"
                          >
                            Configure
                          </button>
                        </>
                      )}
                    </div>
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
