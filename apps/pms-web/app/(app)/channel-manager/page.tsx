'use client'

import { useState, useEffect } from 'react'
import { beds24Service, Beds24Connection, Beds24Property, Beds24Room, Beds24RoomMapping } from '@/services/beds24'
import { roomsService, RoomType } from '@/services/rooms'
import { ArrowPathIcon, TrashIcon, LinkIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/lib/i18n'

type Step = 'connect' | 'select-property' | 'room-mappings'

export default function ChannelManagerPage() {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Connection
  const [connection, setConnection] = useState<Beds24Connection | null>(null)
  const [inviteCode, setInviteCode] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  // Property selection
  const [properties, setProperties] = useState<Beds24Property[]>([])
  const [selectedPropertyId, setSelectedPropertyId] = useState('')
  const [settingProperty, setSettingProperty] = useState(false)
  const [loadingProperties, setLoadingProperties] = useState(false)

  // Room mappings
  const [beds24Rooms, setBeds24Rooms] = useState<Beds24Room[]>([])
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([])
  const [mappings, setMappings] = useState<Beds24RoomMapping[]>([])
  const [newMappingRoomTypeId, setNewMappingRoomTypeId] = useState('')
  const [newMappingBeds24RoomId, setNewMappingBeds24RoomId] = useState('')
  const [creatingMapping, setCreatingMapping] = useState(false)
  const [deletingMappingId, setDeletingMappingId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncingBookings, setSyncingBookings] = useState(false)

  const step: Step = !connection || !connection.isActive
    ? 'connect'
    : !connection.beds24PropertyId
      ? 'select-property'
      : 'room-mappings'

  useEffect(() => {
    loadConnection()
  }, [])

  const loadConnection = async () => {
    setLoading(true)
    try {
      const conn = await beds24Service.getConnection()
      setConnection(conn)
    } catch {
      // No connection yet — that's fine
      setConnection(null)
    } finally {
      setLoading(false)
    }
  }

  // Load properties when we reach step 2
  useEffect(() => {
    if (step === 'select-property') {
      loadProperties()
    }
  }, [step])

  // Load rooms and mappings when we reach step 3
  useEffect(() => {
    if (step === 'room-mappings') {
      loadRoomsAndMappings()
    }
  }, [step])

  const loadProperties = async () => {
    setLoadingProperties(true)
    try {
      const props = await beds24Service.listProperties()
      setProperties(props)
    } catch (err: any) {
      setError(err.message || t('channels.failedToLoadProperties'))
    } finally {
      setLoadingProperties(false)
    }
  }

  const loadRoomsAndMappings = async () => {
    const [b24Result, rTypesResult, mapsResult] = await Promise.allSettled([
      beds24Service.listRooms(),
      roomsService.list(),
      beds24Service.listRoomMappings(),
    ])
    if (b24Result.status === 'fulfilled') {
      setBeds24Rooms(b24Result.value)
    } else {
      setError(t('channels.failedToLoadBeds24Rooms'))
    }
    if (rTypesResult.status === 'fulfilled') setRoomTypes(rTypesResult.value)
    if (mapsResult.status === 'fulfilled') setMappings(mapsResult.value)
  }

  const handleConnect = async () => {
    if (!inviteCode.trim()) return
    setConnecting(true)
    setError('')
    try {
      const conn = await beds24Service.connect(inviteCode.trim())
      setConnection(conn)
      setInviteCode('')
      setSuccess(t('channels.connectedToBeds24'))
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
      await beds24Service.disconnect()
      setConnection(null)
      setMappings([])
      setBeds24Rooms([])
      setProperties([])
      setSuccess(t('channels.disconnectedFromBeds24'))
    } catch (err: any) {
      setError(err.message || t('channels.failedToDisconnect'))
    } finally {
      setDisconnecting(false)
    }
  }

  const handleSetProperty = async () => {
    if (!selectedPropertyId) return
    setSettingProperty(true)
    setError('')
    try {
      const conn = await beds24Service.setProperty(selectedPropertyId)
      setConnection(conn)
      setSuccess(t('channels.propertySelected'))
    } catch (err: any) {
      setError(err.message || t('channels.failedToSetProperty'))
    } finally {
      setSettingProperty(false)
    }
  }

  const handleCreateMapping = async () => {
    if (!newMappingRoomTypeId || !newMappingBeds24RoomId) return
    setCreatingMapping(true)
    setError('')
    try {
      const mapping = await beds24Service.createRoomMapping(newMappingRoomTypeId, newMappingBeds24RoomId)
      setMappings([...mappings, mapping])
      setNewMappingRoomTypeId('')
      setNewMappingBeds24RoomId('')
      setSuccess(t('channels.roomMappingCreated'))
    } catch (err: any) {
      setError(err.message || t('channels.failedToCreateMapping'))
    } finally {
      setCreatingMapping(false)
    }
  }

  const handleDeleteMapping = async (mappingId: string) => {
    setDeletingMappingId(mappingId)
    setError('')
    try {
      await beds24Service.deleteRoomMapping(mappingId)
      setMappings(mappings.filter((m) => m.id !== mappingId))
    } catch (err: any) {
      setError(err.message || t('channels.failedToDeleteMapping'))
    } finally {
      setDeletingMappingId(null)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    setError('')
    try {
      await beds24Service.syncAvailability()
      setSuccess(t('channels.availabilitySyncStarted'))
    } catch (err: any) {
      setError(err.message || t('channels.failedToStartSync'))
    } finally {
      setSyncing(false)
    }
  }

  const handleSyncBookings = async () => {
    setSyncingBookings(true)
    setError('')
    try {
      await beds24Service.syncBookings()
      setSuccess(t('channels.bookingSyncComplete'))
    } catch (err: any) {
      setError(err.message || t('channels.failedToSyncBookings'))
    } finally {
      setSyncingBookings(false)
    }
  }

  // Clear success message after 3s
  useEffect(() => {
    if (success) {
      const t = setTimeout(() => setSuccess(''), 3000)
      return () => clearTimeout(t)
    }
  }, [success])

  const mappedRoomTypeIds = new Set(mappings.map((m) => m.roomTypeId))
  const mappedBeds24RoomIds = new Set(mappings.map((m) => m.beds24RoomId))
  const unmappedRoomTypes = roomTypes.filter((rt) => !mappedRoomTypeIds.has(rt.id))
  const unmappedBeds24Rooms = beds24Rooms.filter((r) => !mappedBeds24RoomIds.has(r.id))

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
          <StepBadge num={2} label={t('channels.stepProperty')} active={step === 'select-property'} done={step === 'room-mappings'} />
          <div className="h-px flex-1 bg-gray-200" />
          <StepBadge num={3} label={t('channels.stepRoomMapping')} active={step === 'room-mappings'} done={false} />
        </div>

        {/* Step 1: Connect */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900">{t('channels.beds24Connection')}</h2>
            {connection?.isActive && (
              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                {t('channels.connected')}
              </span>
            )}
          </div>

          {!connection || !connection.isActive ? (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">
                {t('channels.connectDescription')}
              </p>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">{t('channels.inviteCodeLabel')}</label>
                <input
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder={t('channels.inviteCodePlaceholder')}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <button
                onClick={handleConnect}
                disabled={connecting || !inviteCode.trim()}
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
                  <span className="font-mono text-xs">{connection.beds24PropertyId || t('channels.notSelected')}</span>
                </p>
                {connection.lastSyncAt && (
                  <p>
                    <span className="text-gray-500">{t('channels.lastSync')}</span>{' '}
                    {new Date(connection.lastSyncAt).toLocaleString()}
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

        {/* Step 2: Select Property */}
        {step === 'select-property' && (
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">{t('channels.selectBeds24Property')}</h2>
            {loadingProperties ? (
              <div className="animate-pulse h-20 bg-gray-100 rounded" />
            ) : properties.length === 0 ? (
              <p className="text-sm text-gray-500">{t('channels.noPropertiesFound')}</p>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">{t('channels.propertyLabel')}</label>
                  <select
                    value={selectedPropertyId}
                    onChange={(e) => setSelectedPropertyId(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="">{t('channels.selectProperty')}</option>
                    {properties.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={handleSetProperty}
                  disabled={settingProperty || !selectedPropertyId}
                  className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
                >
                  {settingProperty ? t('channels.savingProperty') : t('channels.confirmProperty')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step 3: Room Mappings */}
        {step === 'room-mappings' && (
          <>
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-gray-900">{t('channels.roomMappings')}</h2>
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
                    onClick={handleSync}
                    disabled={syncing}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary-600 border border-primary-200 rounded-lg hover:bg-primary-50 disabled:opacity-50 transition-colors"
                  >
                    <ArrowPathIcon className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                    {syncing ? t('channels.syncing') : t('channels.syncAvailability')}
                  </button>
                </div>
              </div>

              <p className="text-sm text-gray-600 mb-4">
                {t('channels.roomMappingsDescription')}
              </p>

              {/* Existing mappings */}
              {mappings.length > 0 ? (
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-200 mb-4">
                  {mappings.map((m) => {
                    const roomType = roomTypes.find((rt) => rt.id === m.roomTypeId)
                    const beds24Room = beds24Rooms.find((r) => r.id === m.beds24RoomId)
                    return (
                      <div key={m.id} className="flex items-center justify-between px-4 py-3">
                        <div className="flex items-center gap-3 text-sm min-w-0">
                          <span className="font-medium text-gray-900 truncate">
                            {roomType?.name || m.roomTypeId}
                          </span>
                          <LinkIcon className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                          <span className="text-gray-600 truncate">
                            {beds24Room?.name || m.beds24RoomId}
                            {beds24Room && beds24Room.qty > 1 && (
                              <span className="text-gray-400 ml-1">({beds24Room.qty}x)</span>
                            )}
                          </span>
                        </div>
                        <button
                          onClick={() => handleDeleteMapping(m.id)}
                          disabled={deletingMappingId === m.id}
                          className="p-1.5 text-gray-400 hover:text-red-500 disabled:opacity-50 transition-colors"
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="text-sm text-gray-500 bg-gray-50 rounded-lg p-4 mb-4">
                  {t('channels.noRoomMappings')}
                </div>
              )}

              {/* Add mapping */}
              {unmappedRoomTypes.length > 0 && unmappedBeds24Rooms.length > 0 ? (
                <div className="border-t border-gray-100 pt-4">
                  <h3 className="text-xs font-medium text-gray-700 mb-3">{t('channels.addMapping')}</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('channels.yourRoomType')}</label>
                      <select
                        value={newMappingRoomTypeId}
                        onChange={(e) => setNewMappingRoomTypeId(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      >
                        <option value="">{t('channels.selectRoomType')}</option>
                        {unmappedRoomTypes.map((rt) => (
                          <option key={rt.id} value={rt.id}>{rt.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('channels.beds24Room')}</label>
                      <select
                        value={newMappingBeds24RoomId}
                        onChange={(e) => setNewMappingBeds24RoomId(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                      >
                        <option value="">{t('channels.selectBeds24Room')}</option>
                        {unmappedBeds24Rooms.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name} {r.qty > 1 ? `(${r.qty}x)` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <button
                    onClick={handleCreateMapping}
                    disabled={creatingMapping || !newMappingRoomTypeId || !newMappingBeds24RoomId}
                    className="mt-3 px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
                  >
                    {creatingMapping ? t('channels.adding') : t('channels.addMappingButton')}
                  </button>
                </div>
              ) : mappings.length > 0 ? (
                <p className="text-xs text-gray-500 border-t border-gray-100 pt-4">
                  {t('channels.allRoomsMapped')}
                </p>
              ) : null}
            </div>
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
