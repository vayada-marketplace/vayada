'use client'

import { useState, useEffect, useMemo } from 'react'
import Link from 'next/link'
import { PlusIcon, MagnifyingGlassIcon, ChevronDownIcon, Cog6ToothIcon } from '@heroicons/react/24/outline'
import { roomsService, individualRoomsService, RoomType, Room } from '@/services/rooms'
import { formatCurrency } from '@/lib/utils'

const CATEGORY_STYLES: Record<string, string> = {
  suite: 'bg-blue-50 text-blue-600 border border-blue-200',
  villa: 'bg-green-50 text-green-600 border border-green-200',
  standard: 'bg-gray-50 text-gray-600 border border-gray-200',
  deluxe: 'bg-purple-50 text-purple-600 border border-purple-200',
  bungalow: 'bg-amber-50 text-amber-600 border border-amber-200',
  residence: 'bg-teal-50 text-teal-600 border border-teal-200',
}

function getCategoryFromName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.includes('suite')) return 'suite'
  if (lower.includes('villa')) return 'villa'
  if (lower.includes('deluxe')) return 'deluxe'
  if (lower.includes('bungalow')) return 'bungalow'
  if (lower.includes('residence')) return 'residence'
  return 'standard'
}

function getCategoryLabel(name: string): string {
  const cat = getCategoryFromName(name)
  return cat.charAt(0).toUpperCase() + cat.slice(1)
}


function RoomTypeCard({ room, rooms, onRoomsChange }: { room: RoomType; rooms: Room[]; onRoomsChange: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [addingRoom, setAddingRoom] = useState(false)
  const [newRoomNumber, setNewRoomNumber] = useState('')
  const [newRoomFloor, setNewRoomFloor] = useState('')
  const category = room.category ? room.category.toLowerCase() : getCategoryFromName(room.name)
  const categoryStyle = CATEGORY_STYLES[category] || CATEGORY_STYLES['standard']

  const typeRooms = rooms.filter(r => r.roomTypeId === room.id)
  const available = typeRooms.filter(r => r.status === 'available').length

  const handleAddRoom = async () => {
    if (!newRoomNumber.trim()) return
    try {
      await individualRoomsService.create({
        roomTypeId: room.id,
        roomNumber: newRoomNumber.trim(),
        floor: newRoomFloor.trim(),
      })
      setNewRoomNumber('')
      setNewRoomFloor('')
      setAddingRoom(false)
      onRoomsChange()
    } catch (err: any) {
      alert(err.message || 'Failed to add room')
    }
  }

  const handleDeleteRoom = async (roomId: string) => {
    if (!confirm('Delete this room?')) return
    try {
      await individualRoomsService.delete(roomId)
      onRoomsChange()
    } catch (err: any) {
      alert(err.message || 'Cannot delete room (may have bookings)')
    }
  }

  const handleStatusChange = async (roomId: string, status: string) => {
    try {
      await individualRoomsService.update(roomId, { status })
      onRoomsChange()
    } catch {
      // ignore
    }
  }

  return (
    <div className="border-b border-gray-100 last:border-b-0">
      {/* Room Type Header Row */}
      <div
        className="flex items-center px-5 py-4 hover:bg-gray-50/50 transition-colors cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Expand arrow */}
        <ChevronDownIcon
          className={`w-4 h-4 text-gray-400 mr-3 transition-transform shrink-0 ${expanded ? '' : '-rotate-90'}`}
        />

        {/* Room type icon */}
        <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center mr-4 shrink-0">
          <svg className="w-5 h-5 text-blue-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 21V7a2 2 0 0 1 2-2h6v16" />
            <path d="M13 21V3h6a2 2 0 0 1 2 2v16" />
            <path d="M3 21h18" />
            <path d="M7 9h2" />
            <path d="M7 13h2" />
            <path d="M15 9h2" />
            <path d="M15 13h2" />
          </svg>
        </div>

        {/* Name + info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-gray-900">{room.name}</span>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${categoryStyle}`}>
              {room.category || getCategoryLabel(room.name)}
            </span>
          </div>
          <p className="text-[12px] text-gray-400 mt-0.5">
            {typeRooms.length} room{typeRooms.length !== 1 ? 's' : ''}
            {room.maxOccupancy > 0 && <> &middot; {room.maxOccupancy} occ</>}
            {room.size > 0 && <> &middot; {room.size}m&sup2;</>}
          </p>
        </div>

        {/* Status badges */}
        <div className="flex items-center gap-1.5 mr-6">
          <span className={`w-6 h-6 rounded-full text-white text-[11px] font-bold flex items-center justify-center ${typeRooms.length > 0 ? 'bg-green-500' : 'bg-gray-300'}`} title={`${available} available`}>
            {typeRooms.length}
          </span>
        </div>

        {/* Price */}
        <div className="text-right mr-5 shrink-0">
          {(() => {
            const seasonRates = (room.seasons || []).map(s => parseFloat(s.rate)).filter(r => r > 0)
            const displayRate = seasonRates.length > 0 ? Math.min(...seasonRates) : room.baseRate
            return (
              <>
                <span className="text-lg font-bold text-gray-900">
                  {formatCurrency(displayRate, room.currency)}
                </span>
                <p className="text-[10px] text-gray-400">{seasonRates.length > 1 ? 'from / night' : 'per night'}</p>
              </>
            )
          })()}
        </div>

        {/* Configure button */}
        <Link
          href={`/rooms/${room.id}`}
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors shrink-0"
        >
          <Cog6ToothIcon className="w-3.5 h-3.5" />
          Configure
        </Link>
      </div>

      {/* Expanded: Derived Rates + Individual Rooms */}
      {expanded && (
        <div className="pl-16 pr-5 pb-4">
          {/* Derived Rates */}
          {room.nonRefundableRate != null && room.nonRefundableRate > 0 && (
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[11px] text-gray-400 font-medium">Derived Rates:</span>
              <span className="text-[11px] px-2.5 py-1 bg-gray-50 border border-gray-200 rounded-full text-gray-600">
                Non-Refundable: {formatCurrency(room.nonRefundableRate, room.currency)}
                {room.baseRate > 0 && (
                  <span className="text-gray-400 ml-1">
                    (-{Math.round((1 - room.nonRefundableRate / room.baseRate) * 100)}%)
                  </span>
                )}
              </span>
            </div>
          )}

          {/* Individual rooms */}
          {typeRooms.length > 0 ? (
            typeRooms.map((r) => {
              const statusStyles: Record<string, string> = {
                available: 'bg-green-50 text-green-600 border-green-200',
                maintenance: 'bg-amber-50 text-amber-600 border-amber-200',
                out_of_order: 'bg-red-50 text-red-600 border-red-200',
              }
              return (
                <div
                  key={r.id}
                  className="flex items-center py-2.5 border-l-2 border-gray-200 pl-4 ml-1 hover:border-primary-400 transition-colors"
                >
                  <div className="flex-1">
                    <p className="text-[13px] font-medium text-gray-800">
                      #{r.roomNumber}
                      {r.floor && <span className="text-gray-400 ml-1.5 text-[11px]">Floor {r.floor}</span>}
                    </p>
                  </div>
                  <select
                    value={r.status}
                    onChange={(e) => handleStatusChange(r.id, e.target.value)}
                    className={`text-[11px] font-medium px-2.5 py-1 rounded-full border appearance-none cursor-pointer mr-2 ${statusStyles[r.status] || statusStyles.available}`}
                  >
                    <option value="available">Available</option>
                    <option value="maintenance">Maintenance</option>
                    <option value="out_of_order">Out of Order</option>
                  </select>
                  <button
                    onClick={() => handleDeleteRoom(r.id)}
                    className="p-1 text-gray-300 hover:text-red-500 transition-colors"
                    title="Delete room"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              )
            })
          ) : (
            <p className="text-[12px] text-gray-400 py-2">No rooms yet. Add rooms so bookings can be assigned.</p>
          )}

          {/* Add room form */}
          {addingRoom ? (
            <div className="flex items-center gap-2 mt-2 pl-4 ml-1 border-l-2 border-primary-300">
              <input
                type="text"
                value={newRoomNumber}
                onChange={(e) => setNewRoomNumber(e.target.value)}
                placeholder="Room number (e.g. 101)"
                className="w-32 px-2.5 py-1.5 text-[12px] border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleAddRoom()}
              />
              <input
                type="text"
                value={newRoomFloor}
                onChange={(e) => setNewRoomFloor(e.target.value)}
                placeholder="Floor (opt)"
                className="w-20 px-2.5 py-1.5 text-[12px] border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                onKeyDown={(e) => e.key === 'Enter' && handleAddRoom()}
              />
              <button
                onClick={handleAddRoom}
                className="px-3 py-1.5 text-[11px] font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
              >
                Add
              </button>
              <button
                onClick={() => { setAddingRoom(false); setNewRoomNumber(''); setNewRoomFloor('') }}
                className="px-2 py-1.5 text-[11px] text-gray-500 hover:text-gray-700"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setAddingRoom(true)}
              className="mt-2 ml-5 inline-flex items-center gap-1.5 text-[11px] text-gray-500 font-medium hover:text-primary-600 transition-colors"
            >
              <PlusIcon className="w-3.5 h-3.5" /> Add Room
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default function RoomsPage() {
  const [rooms, setRooms] = useState<RoomType[]>([])
  const [individualRooms, setIndividualRooms] = useState<Room[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')

  const loadData = () => {
    Promise.all([roomsService.list(), individualRoomsService.list()])
      .then(([types, indRooms]) => { setRooms(types); setIndividualRooms(indRooms) })
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadData() }, [])

  const refreshRooms = () => {
    individualRoomsService.list().then(setIndividualRooms).catch(console.error)
  }

  const filteredRooms = useMemo(() => {
    if (!searchQuery.trim()) return rooms
    const q = searchQuery.toLowerCase()
    return rooms.filter((r) => r.name.toLowerCase().includes(q))
  }, [rooms, searchQuery])

  return (
    <div className="p-6 pb-0">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Rooms & Rates</h1>
          <p className="text-sm text-gray-500 mt-1">Manage room inventory and daily pricing</p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/rooms/new"
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 transition-colors"
          >
            <PlusIcon className="w-4 h-4" />
            Add Room Type
          </Link>
        </div>
      </div>

      {/* Search + View Toggle */}
      <div className="flex items-center justify-between mb-5">
        <div className="relative">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search room types..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-72 pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg bg-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
          />
        </div>
      </div>

      {/* Room Type List */}
      {loading ? (
        <div className="animate-pulse space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-20 bg-gray-50 rounded-xl" />
          ))}
        </div>
      ) : filteredRooms.length === 0 && rooms.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-16 text-center">
          <div className="w-14 h-14 bg-gray-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-gray-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 21V7a2 2 0 0 1 2-2h6v16" />
              <path d="M13 21V3h6a2 2 0 0 1 2 2v16" />
              <path d="M3 21h18" />
            </svg>
          </div>
          <p className="text-gray-500 text-sm mb-4">No room types yet. Create your first room type to get started.</p>
          <Link
            href="/rooms/new"
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors"
          >
            <PlusIcon className="w-4 h-4" />
            Add Room Type
          </Link>
        </div>
      ) : filteredRooms.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-sm text-gray-400">No room types match your search.</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          {filteredRooms.map((room) => (
            <RoomTypeCard key={room.id} room={room} rooms={individualRooms} onRoomsChange={refreshRooms} />
          ))}
        </div>
      )}
    </div>
  )
}
