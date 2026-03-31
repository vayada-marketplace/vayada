'use client'

import { useState, useEffect } from 'react'
import { channexService, ChannexSyncStatus, ChannexRoomTypeMapping, ChannexRatePlanMapping } from '@/services/channex'
import { ArrowPathIcon, CheckCircleIcon, LinkIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/lib/i18n'

type Step = 'connect' | 'provision' | 'ready'

export default function ChannelManagerPage() {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Connection
  const [status, setStatus] = useState<ChannexSyncStatus | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  // Provisioning
  const [provisioning, setProvisioning] = useState(false)

  // Mappings
  const [roomMappings, setRoomMappings] = useState<ChannexRoomTypeMapping[]>([])
  const [rateMappings, setRateMappings] = useState<ChannexRatePlanMapping[]>([])

  // Sync
  const [syncingAri, setSyncingAri] = useState(false)
  const [syncingBookings, setSyncingBookings] = useState(false)

  // Channel iframe
  const [iframeUrl, setIframeUrl] = useState<string | null>(null)
  const [loadingIframe, setLoadingIframe] = useState(false)

  const step: Step = !status || !status.isConnected
    ? 'connect'
    : !status.channexPropertyId || status.roomTypesProvisioned === 0
      ? 'provision'
      : 'ready'

  useEffect(() => {
    loadStatus()
  }, [])

  useEffect(() => {
    if (step === 'ready') {
      loadMappings()
    }
  }, [step])

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

  const handleConnect = async () => {
    if (!apiKey.trim()) return
    setConnecting(true)
    setError('')
    try {
      await channexService.connect(apiKey.trim())
      setApiKey('')
      setSuccess(t('channels.connectedToChannex'))
      await loadStatus()
    } catch (err: any) {
      setError(err.message || t('channels.failedToConnect'))
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    if (!confirm(t('channels.disconnectConfirm'))) return
    setDisconnecting(true)
    setError('')
    try {
      await channexService.disconnect()
      setStatus(null)
      setRoomMappings([])
      setRateMappings([])
      setSuccess(t('channels.disconnectedFromChannex'))
    } catch (err: any) {
      setError(err.message || t('channels.failedToDisconnect'))
    } finally {
      setDisconnecting(false)
    }
  }

  const handleProvision = async () => {
    setProvisioning(true)
    setError('')
    try {
      const result = await channexService.provision()
      setSuccess(
        `Provisioned: ${result.roomsCreated} room types, ${result.ratesCreated} rate plans`
      )
      await loadStatus()
    } catch (err: any) {
      setError(err.message || t('channels.failedToProvision'))
    } finally {
      setProvisioning(false)
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
      const { iframeUrl: url } = await channexService.getIframeUrl()
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
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-xl font-bold text-gray-900 mb-6">{t('channels.title')}</h1>

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

      <div className="space-y-8">
        {/* Step indicator */}
        <div className="flex items-center gap-3 text-xs">
          <StepBadge num={1} label={t('channels.stepConnect')} active={step === 'connect'} done={step !== 'connect'} />
          <div className="h-px flex-1 bg-gray-200" />
          <StepBadge num={2} label={t('channels.stepProvision')} active={step === 'provision'} done={step === 'ready'} />
          <div className="h-px flex-1 bg-gray-200" />
          <StepBadge num={3} label={t('channels.stepSync')} active={step === 'ready'} done={false} />
        </div>

        {/* Step 1: Connect */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900">{t('channels.channexConnection')}</h2>
            {status?.isConnected && (
              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                {t('channels.connected')}
              </span>
            )}
          </div>

          {!status || !status.isConnected ? (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">
                {t('channels.channexConnectDescription')}
              </p>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">{t('channels.apiKeyLabel')}</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={t('channels.apiKeyPlaceholder')}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <button
                onClick={handleConnect}
                disabled={connecting || !apiKey.trim()}
                className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
              >
                {connecting ? t('channels.connecting') : t('channels.connect')}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-sm text-gray-600 space-y-1">
                <p>
                  <span className="text-gray-500">{t('channels.propertyIdLabel')}</span>{' '}
                  <span className="font-mono text-xs">{status.channexPropertyId || t('channels.notProvisioned')}</span>
                </p>
                <p>
                  <span className="text-gray-500">{t('channels.roomTypesLabel')}</span>{' '}
                  {status.roomTypesProvisioned} provisioned
                </p>
                <p>
                  <span className="text-gray-500">{t('channels.ratePlansLabel')}</span>{' '}
                  {status.ratePlansProvisioned} provisioned
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
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="px-4 py-2 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors"
              >
                {disconnecting ? t('channels.disconnecting') : t('channels.disconnect')}
              </button>
            </div>
          )}
        </div>

        {/* Step 2: Provision */}
        {step === 'provision' && (
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('channels.provisionTitle')}</h2>
            <p className="text-sm text-gray-600 mb-4">
              {t('channels.provisionDescription')}
            </p>
            <button
              onClick={handleProvision}
              disabled={provisioning}
              className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {provisioning ? t('channels.provisioning') : t('channels.provisionButton')}
            </button>
          </div>
        )}

        {/* Step 3: Ready — sync controls + mappings */}
        {step === 'ready' && (
          <>
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-gray-900">{t('channels.syncControls')}</h2>
                <div className="flex items-center gap-2">
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
              <p className="text-sm text-gray-600">
                {t('channels.syncDescription')}
              </p>
            </div>

            {/* OTA Channel Connections (iframe) */}
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-gray-900">{t('channels.otaConnections')}</h2>
                {!iframeUrl && (
                  <button
                    onClick={handleOpenChannels}
                    disabled={loadingIframe}
                    className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
                  >
                    {loadingIframe ? t('channels.loading') : t('channels.manageChannels')}
                  </button>
                )}
                {iframeUrl && (
                  <button
                    onClick={() => setIframeUrl(null)}
                    className="px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
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

            {/* Provisioned mappings */}
            {roomMappings.length > 0 && (
              <div className="bg-white border border-gray-200 rounded-xl p-6">
                <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('channels.provisionedRoomTypes')}</h2>
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-200">
                  {roomMappings.map((m) => {
                    const rateMapping = rateMappings.find((r) => r.roomTypeId === m.roomTypeId)
                    return (
                      <div key={m.id} className="flex items-center justify-between px-4 py-3">
                        <div className="flex items-center gap-3 text-sm min-w-0">
                          <CheckCircleIcon className="w-4 h-4 text-green-500 shrink-0" />
                          <span className="font-medium text-gray-900 truncate">
                            {(m as any).roomTypeName || m.roomTypeId}
                          </span>
                          <LinkIcon className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                          <span className="text-gray-500 font-mono text-xs truncate">
                            {m.channexRoomTypeId.slice(0, 8)}...
                          </span>
                        </div>
                        {rateMapping && (
                          <span className="text-xs text-gray-400">
                            {rateMapping.sellMode}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function StepBadge({ num, label, active, done }: { num: number; label: string; active: boolean; done: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
          done
            ? 'bg-green-100 text-green-700'
            : active
              ? 'bg-primary-100 text-primary-700'
              : 'bg-gray-100 text-gray-400'
        }`}
      >
        {done ? '\u2713' : num}
      </span>
      <span className={`font-medium ${active ? 'text-gray-900' : done ? 'text-green-700' : 'text-gray-400'}`}>
        {label}
      </span>
    </div>
  )
}
