'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { TrashIcon, XMarkIcon } from '@heroicons/react/24/outline'
import {
  settingsService,
  type HotelSummary,
  type HotelDeletionImpact,
} from '@/services/settings'
import { Button, FeedbackAlert } from '@/components/ui'
import { useTranslation } from '@/lib/i18n'

type Toast = { type: 'success' | 'error'; message: string } | null

export default function ManagePropertiesPage() {
  const router = useRouter()
  const { t } = useTranslation()
  const [hotels, setHotels] = useState<HotelSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [target, setTarget] = useState<HotelSummary | null>(null)
  const [impact, setImpact] = useState<HotelDeletionImpact | null>(null)
  const [step, setStep] = useState<1 | 2>(1)
  const [typed, setTyped] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState<Toast>(null)

  useEffect(() => {
    settingsService.listHotels()
      .then(setHotels)
      .catch(() => setToast({ type: 'error', message: t('manageProperties.toast.error') }))
      .finally(() => setLoading(false))
  }, [t])

  const openConfirm = async (hotel: HotelSummary) => {
    setTarget(hotel)
    setImpact(null)
    setStep(1)
    setTyped('')
    try {
      const data = await settingsService.getHotelDeletionImpact(hotel.id)
      setImpact(data)
    } catch {
      // Impact lookup is informational; fall back to zeros so the
      // dialog still opens.
      setImpact({ upcomingBookingsCount: 0, connectedChannelsCount: 0 })
    }
  }

  const closeDialog = () => {
    if (submitting) return
    setTarget(null)
    setImpact(null)
    setStep(1)
    setTyped('')
  }

  const onProceedToStep2 = () => setStep(2)

  const onConfirmDelete = async () => {
    if (!target || typed !== target.name) return
    setSubmitting(true)
    try {
      await settingsService.deleteHotel(target.id)
      const remaining = hotels.filter((h) => h.id !== target.id)
      setHotels(remaining)

      const wasSelected = localStorage.getItem('selectedHotelId') === target.id
      if (wasSelected) {
        if (remaining.length > 0) {
          localStorage.setItem('selectedHotelId', remaining[0].id)
        } else {
          localStorage.removeItem('selectedHotelId')
        }
      }

      setToast({
        type: 'success',
        message: t('manageProperties.toast.deleted', { name: target.name }),
      })
      closeDialog()

      if (remaining.length === 0) {
        router.push('/setup?mode=add')
      }
    } catch {
      setToast({ type: 'error', message: t('manageProperties.toast.error') })
      setSubmitting(false)
      return
    }
    setSubmitting(false)
  }

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t('manageProperties.title')}</h1>
        <p className="text-[13px] text-gray-500 mt-1">{t('manageProperties.subtitle')}</p>
      </div>

      {toast && (
        <FeedbackAlert type={toast.type} message={toast.message} />
      )}

      <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        {loading ? (
          <div className="p-6 text-center text-[13px] text-gray-400">…</div>
        ) : hotels.length === 0 ? (
          <div className="p-6 text-center text-[13px] text-gray-500">
            {t('manageProperties.empty')}
          </div>
        ) : (
          hotels.map((hotel) => (
            <div key={hotel.id} className="flex items-center justify-between p-4">
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-gray-900 truncate">{hotel.name}</p>
                <p className="text-[12px] text-gray-500 truncate">{hotel.location}</p>
              </div>
              <Button
                variant="danger"
                size="sm"
                onClick={() => openConfirm(hotel)}
                className="flex items-center gap-1.5"
              >
                <TrashIcon className="w-3.5 h-3.5" />
                {t('manageProperties.delete')}
              </Button>
            </div>
          ))
        )}
      </div>

      {target && step === 1 && (
        <DeleteWarningDialog
          name={target.name}
          impact={impact}
          loading={submitting}
          onCancel={closeDialog}
          onConfirm={onProceedToStep2}
          t={t}
        />
      )}

      {target && step === 2 && (
        <DeleteNameMatchDialog
          name={target.name}
          typed={typed}
          onTyped={setTyped}
          loading={submitting}
          onCancel={closeDialog}
          onConfirm={onConfirmDelete}
          t={t}
        />
      )}
    </div>
  )
}

function DeleteWarningDialog({
  name,
  impact,
  loading,
  onCancel,
  onConfirm,
  t,
}: {
  name: string
  impact: HotelDeletionImpact | null
  loading: boolean
  onCancel: () => void
  onConfirm: () => void
  t: (k: string, p?: Record<string, string | number>) => string
}) {
  return (
    <DialogShell title={t('manageProperties.confirm.title')} onClose={onCancel} loading={loading}>
      <p className="text-[13px] text-gray-700">
        {t('manageProperties.confirm.body', { name })}
      </p>
      {impact && impact.upcomingBookingsCount > 0 && (
        <div className="mt-3 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[12px] text-amber-900">
          {t('manageProperties.confirm.bookingsWarning', { count: impact.upcomingBookingsCount })}
        </div>
      )}
      {impact && impact.connectedChannelsCount > 0 && (
        <div className="mt-3 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[12px] text-amber-900">
          {t('manageProperties.confirm.channelsWarning', { count: impact.connectedChannelsCount })}
        </div>
      )}
      <div className="flex items-center justify-end gap-2 mt-5">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={loading}>
          {t('manageProperties.confirm.cancel')}
        </Button>
        <Button variant="danger" size="sm" onClick={onConfirm} disabled={loading}>
          {t('manageProperties.confirm.proceed')}
        </Button>
      </div>
    </DialogShell>
  )
}

function DeleteNameMatchDialog({
  name,
  typed,
  onTyped,
  loading,
  onCancel,
  onConfirm,
  t,
}: {
  name: string
  typed: string
  onTyped: (v: string) => void
  loading: boolean
  onCancel: () => void
  onConfirm: () => void
  t: (k: string, p?: Record<string, string | number>) => string
}) {
  // Case-sensitive exact match — the destructive-action gate the ticket calls for.
  const matches = typed === name
  return (
    <DialogShell title={t('manageProperties.confirmName.title')} onClose={onCancel} loading={loading}>
      <p className="text-[13px] text-gray-700">
        {t('manageProperties.confirmName.body', { name })}
      </p>
      <input
        type="text"
        value={typed}
        onChange={(e) => onTyped(e.target.value)}
        placeholder={t('manageProperties.confirmName.placeholder')}
        autoFocus
        disabled={loading}
        className="mt-3 w-full px-3 py-2 text-[13px] border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500"
      />
      <div className="flex items-center justify-end gap-2 mt-5">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={loading}>
          {t('manageProperties.confirm.cancel')}
        </Button>
        <Button variant="danger" size="sm" onClick={onConfirm} disabled={!matches || loading}>
          {t('manageProperties.confirmName.button')}
        </Button>
      </div>
    </DialogShell>
  )
}

function DialogShell({
  title,
  onClose,
  loading,
  children,
}: {
  title: string
  onClose: () => void
  loading: boolean
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={loading ? undefined : onClose}
      />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h3 className="text-[15px] font-semibold text-gray-900">{title}</h3>
          <button
            onClick={onClose}
            disabled={loading}
            className="p-1 text-gray-400 hover:text-gray-600 rounded-md disabled:opacity-50"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}
