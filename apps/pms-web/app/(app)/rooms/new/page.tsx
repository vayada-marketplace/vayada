'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeftIcon } from '@heroicons/react/24/outline'
import Link from 'next/link'
import { roomsService, RoomTypeCreate } from '@/services/rooms'
import RoomTypeForm from '@/components/rooms/RoomTypeForm'

export default function NewRoomPage() {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState<RoomTypeCreate>({
    name: '',
    description: '',
    shortDescription: '',
    maxOccupancy: 2,
    size: 0,
    baseRate: 0,
    nonRefundableRate: null,
    currency: 'EUR',
    bedType: '',
    totalRooms: 1,
    amenities: [],
    features: [],
    images: [],
    isActive: true,
    sortOrder: 0,
    monthlyRates: {},
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name) {
      setError('Name is required')
      return
    }
    setSaving(true)
    setError('')
    try {
      await roomsService.create(form)
      router.push('/rooms')
    } catch (err: any) {
      setError(err.message || 'Failed to create room type')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/rooms" className="text-gray-400 hover:text-gray-600">
          <ArrowLeftIcon className="w-5 h-5" />
        </Link>
        <h1 className="text-xl font-bold text-gray-900">New Room Type</h1>
      </div>

      <RoomTypeForm
        form={form}
        onChange={setForm}
        onSubmit={handleSubmit}
        saving={saving}
        error={error}
        submitLabel="Create Room Type"
        cancelHref="/rooms"
      />
    </div>
  )
}
