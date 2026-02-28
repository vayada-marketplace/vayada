'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeftIcon, TrashIcon } from '@heroicons/react/24/outline'
import Link from 'next/link'
import { roomsService, RoomType, RoomTypeUpdate } from '@/services/rooms'
import ImageUpload from '@/components/ImageUpload'
import MonthlyRatesEditor from '@/components/MonthlyRatesEditor'

export default function EditRoomPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [room, setRoom] = useState<RoomType | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [form, setForm] = useState<RoomTypeUpdate>({})
  const [amenityInput, setAmenityInput] = useState('')
  const [featureInput, setFeatureInput] = useState('')

  useEffect(() => {
    roomsService.get(params.id)
      .then((r) => {
        setRoom(r)
        setForm({
          name: r.name,
          description: r.description,
          shortDescription: r.shortDescription,
          maxOccupancy: r.maxOccupancy,
          size: r.size,
          baseRate: r.baseRate,
          nonRefundableRate: r.nonRefundableRate,
          currency: r.currency,
          bedType: r.bedType,
          totalRooms: r.totalRooms,
          amenities: r.amenities,
          features: r.features,
          images: r.images,
          isActive: r.isActive,
          sortOrder: r.sortOrder,
          monthlyRates: r.monthlyRates || {},
        })
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [params.id])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      await roomsService.update(params.id, form)
      setSuccess('Room type updated successfully')
    } catch (err: any) {
      setError(err.message || 'Failed to update')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this room type?')) return
    setDeleting(true)
    try {
      await roomsService.delete(params.id)
      router.push('/rooms')
    } catch (err: any) {
      setError(err.message || 'Cannot delete — room type may have bookings')
      setDeleting(false)
    }
  }

  const addToList = (field: 'amenities' | 'features' | 'images', value: string, setter: (v: string) => void) => {
    if (!value.trim()) return
    setForm({ ...form, [field]: [...(form[field] || []), value.trim()] })
    setter('')
  }

  const removeFromList = (field: 'amenities' | 'features' | 'images', index: number) => {
    const list = [...(form[field] || [])]
    list.splice(index, 1)
    setForm({ ...form, [field]: list })
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="h-96 bg-gray-200 rounded" />
        </div>
      </div>
    )
  }

  if (!room) {
    return (
      <div className="p-6">
        <p className="text-gray-500">Room type not found.</p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/rooms" className="text-gray-400 hover:text-gray-600">
            <ArrowLeftIcon className="w-5 h-5" />
          </Link>
          <h1 className="text-xl font-bold text-gray-900">Edit: {room.name}</h1>
        </div>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
        >
          <TrashIcon className="w-4 h-4" />
          {deleting ? 'Deleting...' : 'Delete'}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          {success}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-5">
          <h2 className="text-sm font-semibold text-gray-900">Basic Information</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
              <input
                type="text"
                value={form.name || ''}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Bed Type</label>
              <input
                type="text"
                value={form.bedType || ''}
                onChange={(e) => setForm({ ...form, bedType: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Short Description</label>
            <input
              type="text"
              value={form.shortDescription || ''}
              onChange={(e) => setForm({ ...form, shortDescription: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea
              value={form.description || ''}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 resize-y"
            />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Flexible Rate</label>
              <input
                type="number"
                step="0.01"
                value={form.baseRate ?? 0}
                onChange={(e) => setForm({ ...form, baseRate: parseFloat(e.target.value) || 0 })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Non-Refundable Rate</label>
              <input
                type="number"
                step="0.01"
                value={form.nonRefundableRate ?? ''}
                onChange={(e) => setForm({ ...form, nonRefundableRate: e.target.value ? parseFloat(e.target.value) : null })}
                placeholder="Optional"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
              <input
                type="text"
                value={form.currency || ''}
                onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
                maxLength={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Max Occupancy</label>
              <input
                type="number"
                value={form.maxOccupancy ?? 2}
                onChange={(e) => setForm({ ...form, maxOccupancy: parseInt(e.target.value) || 1 })}
                min={1}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Size (m&sup2;)</label>
              <input
                type="number"
                value={form.size ?? 0}
                onChange={(e) => setForm({ ...form, size: parseInt(e.target.value) || 0 })}
                min={0}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Total Rooms</label>
              <input
                type="number"
                value={form.totalRooms ?? 1}
                onChange={(e) => setForm({ ...form, totalRooms: parseInt(e.target.value) || 1 })}
                min={1}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Sort Order</label>
              <input
                type="number"
                value={form.sortOrder ?? 0}
                onChange={(e) => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })}
                min={0}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isActive ?? true}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  className="w-4 h-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                />
                <span className="text-sm text-gray-700">Active</span>
              </label>
            </div>
          </div>
        </div>

        {/* Amenities */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-3">
          <h2 className="text-sm font-semibold text-gray-900">Amenities</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={amenityInput}
              onChange={(e) => setAmenityInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addToList('amenities', amenityInput, setAmenityInput))}
              placeholder="e.g. Free WiFi"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <button
              type="button"
              onClick={() => addToList('amenities', amenityInput, setAmenityInput)}
              className="px-3 py-2 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200"
            >
              Add
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {(form.amenities || []).map((a, i) => (
              <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-100 text-gray-700 text-xs rounded-full">
                {a}
                <button type="button" onClick={() => removeFromList('amenities', i)} className="text-gray-400 hover:text-gray-600">&times;</button>
              </span>
            ))}
          </div>
        </div>

        {/* Features */}
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-3">
          <h2 className="text-sm font-semibold text-gray-900">Features</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={featureInput}
              onChange={(e) => setFeatureInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addToList('features', featureInput, setFeatureInput))}
              placeholder="e.g. Mountain View"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <button
              type="button"
              onClick={() => addToList('features', featureInput, setFeatureInput)}
              className="px-3 py-2 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200"
            >
              Add
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {(form.features || []).map((f, i) => (
              <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-100 text-gray-700 text-xs rounded-full">
                {f}
                <button type="button" onClick={() => removeFromList('features', i)} className="text-gray-400 hover:text-gray-600">&times;</button>
              </span>
            ))}
          </div>
        </div>

        {/* Images */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <ImageUpload
            images={form.images || []}
            onChange={(urls) => setForm({ ...form, images: urls })}
            maxImages={10}
            label="Room Images"
          />
        </div>

        {/* Monthly Pricing */}
        <MonthlyRatesEditor
          monthlyRates={form.monthlyRates || {}}
          defaultBaseRate={form.baseRate || 0}
          defaultNonRefundableRate={form.nonRefundableRate}
          onChange={(rates) => setForm({ ...form, monthlyRates: rates })}
        />

        <div className="flex items-center justify-end gap-3">
          <Link
            href="/rooms"
            className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  )
}
