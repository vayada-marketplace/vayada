'use client'

import { useState, useEffect } from 'react'
import { channexService, ChannexSyncStatus, ChannexRoomTypeMapping, ChannexRatePlanMapping, ChannelMarkup } from '@/services/channex'
import { ArrowPathIcon, CheckCircleIcon, LinkIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/lib/i18n'
import ConfirmDialog from '@/components/ConfirmDialog'

export default function ChannelManagerPage() {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [status, setStatus] = useState<ChannexSyncStatus | null>(null)
  const [enabling, setEnabling] = useState(false)
  const [disabling, setDisabling] = useState(false)
  const [showDisableConfirm, setShowDisableConfirm] = useState(false)

  // Mappings
  const [roomMappings, setRoomMappings] = useState<ChannexRoomTypeMapping[]>([])
  const [rateMappings, setRateMappings] = useState<ChannexRatePlanMapping[]>([])

  // Sync
  const [syncingAri, setSyncingAri] = useState(false)
  const [syncingBookings, setSyncingBookings] = useState(false)

  // Channel iframe
  const [iframeUrl, setIframeUrl] = useState<string | null>(null)
  const [loadingIframe, setLoadingIframe] = useState(false)

  // Channel pricing markups
  const [bookingComMarkup, setBookingComMarkup] = useState('0')
  const [airbnbMarkup, setAirbnbMarkup] = useState('0')
  const [savingMarkups, setSavingMarkups] = useState(false)

  const isEnabled = status?.isConnected && status?.channexPropertyId

  useEffect(() => {
    loadStatus()
  }, [])

  useEffect(() => {
    if (isEnabled) {
      loadMappings()
      loadMarkups()
    }
  }, [isEnabled])

  const loadStatus = async () => {
    setLoading(true)
    try {
      const s = await channexService.getStatus()
      setStatus(s)
    } catch {
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }

  const loadMappings = async () => {
    const [rooms, rates] = await Promise.allSettled([
      channexService.listRoomTypeMappings(),
      channexService.listRatePlanMappings(),
    ])
    if (rooms.status === 'fulfilled') setRoomMappings(rooms.value)
    if (rates.status === 'fulfilled') setRateMappings(rates.value)
  }

  const loadMarkups = async () => {
    try {
      const { markups } = await channexService.getMarkups()
      const bdc = markups.find((m) => m.channel === 'booking_com')
      const abb = markups.find((m) => m.channel === 'airbnb')
      setBookingComMarkup(bdc ? String(bdc.markupPct) : '0')
      setAirbnbMarkup(abb ? String(abb.markupPct) : '0')
    } catch {
      // ignore — card still renders with defaults
    }
  }

  const handleSaveMarkups = async () => {
    setSavingMarkups(true)
    setError('')
    try {
      const payload: ChannelMarkup[] = [
        { channel: 'booking_com', markupPct: Number(bookingComMarkup) || 0 },
        { channel: 'airbnb', markupPct: Number(airbnbMarkup) || 0 },
      ]
      await channexService.updateMarkups(payload)
      setSuccess(t('channels.pricingSaved'))
      await loadStatus()
    } catch (err: any) {
      setError(err.message || t('channels.failedToSavePricing'))
    } finally {
      setSavingMarkups(false)
    }
  }

  const handleEnable = async () => {
    setEnabling(true)
    setError('')
    try {
      const result = await channexService.enable()
      setSuccess(
        result.status === 'already_enabled'
          ? t('channels.alreadyEnabled')
          : `${t('channels.enabled')} (${result.roomsCreated} rooms, ${result.ratesCreated} rates)`
      )
      await loadStatus()
    } catch (err: any) {
      setError(err.message || t('channels.failedToEnable'))
    } finally {
      setEnabling(false)
    }
  }

  const handleDisable = async () => {
    setShowDisableConfirm(false)
    setDisabling(true)
    setError('')
    try {
      await channexService.disable()
      setStatus(null)
      setRoomMappings([])
      setRateMappings([])
      setIframeUrl(null)
      setSuccess(t('channels.disabled'))
    } catch (err: any) {
      setError(err.message || t('channels.failedToDisable'))
    } finally {
      setDisabling(false)
    }
  }

  const handleSyncAri = async () => {
    setSyncingAri(true)
    setError('')
    try {
      await channexService.syncAri()
      setSuccess(t('channels.ariSyncStarted'))
      await loadStatus()
    } catch (err: any) {
      setError(err.message || t('channels.failedToStartSync'))
    } finally {
      setSyncingAri(false)
    }
  }

  const handleSyncBookings = async () => {
    setSyncingBookings(true)
    setError('')
    try {
      await channexService.syncBookings()
      setSuccess(t('channels.bookingSyncComplete'))
      await loadStatus()
    } catch (err: any) {
      setError(err.message || t('channels.failedToSyncBookings'))
    } finally {
      setSyncingBookings(false)
    }
  }

  const handleOpenChannels = async () => {
    setLoadingIframe(true)
    setError('')
    try {
      const { iframe_url: url } = await channexService.getIframeUrl()
      setIframeUrl(url)
    } catch (err: any) {
      setError(err.message || t('channels.failedToLoadIframe'))
    } finally {
      setLoadingIframe(false)
    }
  }

  // Clear success message after 3s
  useEffect(() => {
    if (success) {
      const timer = setTimeout(() => setSuccess(''), 3000)
      return () => clearTimeout(timer)
    }
  }, [success])

  if (loading) {
    return (
      <div className="p-4 md:p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl">
      <h1 className="text-2xl md:text-xl font-bold text-gray-900 mb-5 md:mb-6">{t('channels.title')}</h1>

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

      <div className="space-y-6">
        {!isEnabled ? (
          /* ── Not enabled ─────────────────────────────── */
          <div className="bg-white border border-gray-200 rounded-xl p-5 md:p-6 text-center">
            <h2 className="text-sm font-semibold text-gray-900 mb-2">{t('channels.title')}</h2>
            <p className="text-sm text-gray-600 mb-5">
              {t('channels.enableDescription')}
            </p>
            <button
              onClick={handleEnable}
              disabled={enabling}
              className="px-5 py-2.5 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {enabling ? t('channels.enabling') : t('channels.enableButton')}
            </button>
          </div>
        ) : (
          /* ── Enabled ─────────────────────────────────── */
          <>
            {/* Status bar */}
            <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-6">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-gray-900">{t('channels.title')}</h2>
                  <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                    {t('channels.active')}
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={handleSyncBookings}
                    disabled={syncingBookings}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary-600 border border-primary-200 rounded-lg hover:bg-primary-50 disabled:opacity-50 transition-colors"
                  >
                    <ArrowPathIcon className={`w-3.5 h-3.5 ${syncingBookings ? 'animate-spin' : ''}`} />
                    {syncingBookings ? t('channels.syncing') : t('channels.syncBookings')}
                  </button>
                  <button
                    onClick={handleSyncAri}
                    disabled={syncingAri}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary-600 border border-primary-200 rounded-lg hover:bg-primary-50 disabled:opacity-50 transition-colors"
                  >
                    <ArrowPathIcon className={`w-3.5 h-3.5 ${syncingAri ? 'animate-spin' : ''}`} />
                    {syncingAri ? t('channels.syncing') : t('channels.syncAri')}
                  </button>
                </div>
              </div>
              <div className="text-sm text-gray-600 space-y-1">
                <p>
                  <span className="text-gray-500">{t('channels.roomTypesLabel')}</span>{' '}
                  {status.roomTypesProvisioned} {t('channels.provisioned')}
                </p>
                <p>
                  <span className="text-gray-500">{t('channels.ratePlansLabel')}</span>{' '}
                  {status.ratePlansProvisioned} {t('channels.provisioned')}
                </p>
                {status.lastAriSyncAt && (
                  <p>
                    <span className="text-gray-500">{t('channels.lastAriSync')}</span>{' '}
                    {new Date(status.lastAriSyncAt).toLocaleString()}
                  </p>
                )}
                {status.lastBookingSyncAt && (
                  <p>
                    <span className="text-gray-500">{t('channels.lastBookingSync')}</span>{' '}
                    {new Date(status.lastBookingSyncAt).toLocaleString()}
                  </p>
                )}
              </div>
            </div>

            {/* OTA Channel Connections (iframe) */}
            <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-6">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
                <h2 className="text-sm font-semibold text-gray-900">{t('channels.otaConnections')}</h2>
                {!iframeUrl ? (
                  <button
                    onClick={handleOpenChannels}
                    disabled={loadingIframe}
                    className="w-full md:w-auto px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
                  >
                    {loadingIframe ? t('channels.loading') : t('channels.manageChannels')}
                  </button>
                ) : (
                  <button
                    onClick={() => setIframeUrl(null)}
                    className="w-full md:w-auto px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    {t('channels.closeChannels')}
                  </button>
                )}
              </div>

              {!iframeUrl ? (
                <p className="text-sm text-gray-600">
                  {t('channels.otaDescription')}
                </p>
              ) : (
                <iframe
                  src={iframeUrl}
                  className="w-full border border-gray-200 rounded-lg"
                  style={{ height: '700px' }}
                  allow="clipboard-write"
                />
              )}
            </div>

            {/* Channel pricing */}
            <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-6">
              <h2 className="text-sm font-semibold text-gray-900 mb-1">{t('channels.pricingTitle')}</h2>
              <p className="text-sm text-gray-600 mb-4">{t('channels.pricingDescription')}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    {t('channels.bookingComMarkup')}
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.1"
                      min="-50"
                      max="200"
                      value={bookingComMarkup}
                      onChange={(e) => setBookingComMarkup(e.target.value)}
                      className="w-full pr-8 pl-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    {t('channels.airbnbMarkup')}
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.1"
                      min="-50"
                      max="200"
                      value={airbnbMarkup}
                      onChange={(e) => setAirbnbMarkup(e.target.value)}
                      className="w-full pr-8 pl-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
                  </div>
                </div>
              </div>
              <p className="text-xs text-gray-500 mb-4">{t('channels.markupHint')}</p>
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
                {t('channels.remapHint')}
              </p>
              <button
                onClick={handleSaveMarkups}
                disabled={savingMarkups}
                className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
              >
                {savingMarkups ? t('channels.savingPricing') : t('channels.savePricing')}
              </button>
            </div>

            {/* Provisioned room types */}
            {roomMappings.length > 0 && (
              <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-6">
                <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('channels.provisionedRoomTypes')}</h2>
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-200">
                  {roomMappings.map((m) => {
                    const rateMapping = rateMappings.find((r) => r.roomTypeId === m.roomTypeId)
                    return (
                      <div key={m.id} className="flex items-center justify-between gap-2 px-3 md:px-4 py-3">
                        <div className="flex items-center gap-2 md:gap-3 text-sm min-w-0 flex-1">
                          <CheckCircleIcon className="w-4 h-4 text-green-500 shrink-0" />
                          <span className="font-medium text-gray-900 truncate">
                            {m.roomTypeName || m.roomTypeId}
                          </span>
                          <LinkIcon className="w-3.5 h-3.5 text-gray-400 shrink-0 hidden md:inline-block" />
                          <span className="text-gray-500 font-mono text-xs truncate hidden md:inline-block">
                            {m.channexRoomTypeId.slice(0, 8)}...
                          </span>
                        </div>
                        {rateMapping && (
                          <span className="shrink-0 text-xs text-gray-400">
                            {rateMapping.sellMode}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Disable */}
            <div className="pt-2">
              <button
                onClick={() => setShowDisableConfirm(true)}
                disabled={disabling}
                className="w-full md:w-auto px-4 py-2 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                {disabling ? t('channels.disabling') : t('channels.disableButton')}
              </button>
            </div>
          </>
        )}
      </div>

      {showDisableConfirm && (
        <ConfirmDialog
          title={t('channels.disable')}
          message={t('channels.disableConfirm')}
          confirmLabel={t('channels.disable')}
          variant="danger"
          onConfirm={handleDisable}
          onCancel={() => setShowDisableConfirm(false)}
        />
      )}
    </div>
  )
}
