'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeftIcon, TrashIcon } from '@heroicons/react/24/outline'
import Link from 'next/link'
import { roomsService, RoomType, RoomTypeUpdate } from '@/services/rooms'
import { bookingsService } from '@/services/bookings'
import RoomTypeForm from '@/components/rooms/RoomTypeForm'
import ConfirmDialog from '@/components/ConfirmDialog'

export default function EditRoomPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [room, setRoom] = useState<RoomType | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [form, setForm] = useState<RoomTypeUpdate>({})
  const [initialCurrency, setInitialCurrency] = useState('EUR')

  useEffect(() => {
    roomsService.get(params.id)
      .then((r) => {
        setRoom(r)
        setForm({
          name: r.name,
          category: r.category || '',
          description: r.description,
          shortDescription: r.shortDescription,
          maxOccupancy: r.maxOccupancy,
          bedrooms: r.bedrooms ?? 1,
          bathrooms: r.bathrooms ?? 1,
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
          dailyRates: r.dailyRates || {},
          operatingPeriods: r.operatingPeriods || [],
          seasons: r.seasons || [],
          weekendSurcharge: r.weekendSurcharge || '+0%',
          cancellationPolicy: r.cancellationPolicy || 'Free until 7 days before',
          flexibleRateEnabled: r.flexibleRateEnabled ?? true,
          nonRefundableEnabled: r.nonRefundableEnabled ?? false,
          nonRefundableDiscount: r.nonRefundableDiscount ?? 10,
          minimumAdvanceDays: r.minimumAdvanceDays ?? 0,
          ratePaymentMethods: r.ratePaymentMethods ?? null,
        })
      })
      .catch(console.error)
      .finally(() => setLoading(false))

    // Override currency from payment settings (authoritative source)
    bookingsService.getPaymentSettings()
      .then((res) => {
        const c = res.paymentSettings.defaultCurrency
        if (c) {
          setInitialCurrency(c)
          setForm((prev) => ({ ...prev, currency: c }))
        }
      })
      .catch(console.error)
  }, [params.id])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.seasons?.length || !form.seasons.some(s => s.rate && Number(s.rate) > 0)) {
      setError('At least one season with a rate greater than 0 is required')
      return
    }
    if (form.seasons.some(s => s.from && s.to && (!s.rate || Number(s.rate) <= 0))) {
      setError('Every season must have a rate greater than 0')
      return
    }
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      if (form.currency && form.currency !== initialCurrency) {
        await bookingsService.updatePaymentSettings({ defaultCurrency: form.currency })
      }
      await roomsService.update(params.id, form)
      setSuccess('Room type updated successfully')
    } catch (err: any) {
      setError(err.message || 'Failed to update')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    setShowDeleteConfirm(false)
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
    <div className="p-4 md:p-6 max-w-5xl">
      <div className="flex items-center justify-between gap-3 mb-5 md:mb-6">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/rooms" className="text-gray-400 hover:text-gray-600 shrink-0">
            <ArrowLeftIcon className="w-5 h-5" />
          </Link>
          <h1 className="text-xl font-bold text-gray-900 truncate">Edit: {room.name}</h1>
        </div>
        <button
          onClick={() => setShowDeleteConfirm(true)}
          disabled={deleting}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 shrink-0"
        >
          <TrashIcon className="w-4 h-4" />
          <span className="hidden md:inline">{deleting ? 'Deleting...' : 'Delete'}</span>
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
      {showDeleteConfirm && (
        <ConfirmDialog
          title="Delete Room Type"
          message="Are you sure you want to delete this room type? This cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  )
}
