'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeftIcon, TrashIcon } from '@heroicons/react/24/outline'
import Link from 'next/link'
import { roomsService, RoomType, RoomTypeUpdate } from '@/services/rooms'
import RoomTypeForm from '@/components/rooms/RoomTypeForm'

export default function EditRoomPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [room, setRoom] = useState<RoomType | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [form, setForm] = useState<RoomTypeUpdate>({})

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
          benefits: r.benefits,
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

      <RoomTypeForm
        form={form}
        onChange={setForm}
        onSubmit={handleSubmit}
        saving={saving}
        error={error}
        success={success}
        submitLabel="Save Changes"
        cancelHref="/rooms"
      />
    </div>
  )
}
