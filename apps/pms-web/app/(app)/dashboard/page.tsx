'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { roomsService, RoomType } from '@/services/rooms'
import { bookingsService, Booking } from '@/services/bookings'
import { affiliatesService } from '@/services/affiliates'

export default function DashboardPage() {
  const [rooms, setRooms] = useState<RoomType[]>([])
  const [pendingBookings, setPendingBookings] = useState<Booking[]>([])
  const [totalBookings, setTotalBookings] = useState(0)
  const [totalAffiliates, setTotalAffiliates] = useState(0)
  const [pendingAffiliates, setPendingAffiliates] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      roomsService.list(),
      bookingsService.list({ status: 'pending', limit: 5 }),
      bookingsService.list({ limit: 1 }),
      affiliatesService.list({ limit: 1 }).catch(() => ({ total: 0 })),
      affiliatesService.list({ status: 'pending', limit: 1 }).catch(() => ({ total: 0 })),
    ])
      .then(([roomsList, pendingRes, allRes, affRes, affPendingRes]) => {
        setRooms(roomsList)
        setPendingBookings(pendingRes.bookings)
        setTotalBookings(allRes.total)
        setTotalAffiliates(affRes.total)
        setPendingAffiliates(affPendingRes.total)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="grid grid-cols-4 gap-4">
            <div className="h-24 bg-gray-200 rounded" />
            <div className="h-24 bg-gray-200 rounded" />
            <div className="h-24 bg-gray-200 rounded" />
            <div className="h-24 bg-gray-200 rounded" />
          </div>
        </div>
      </div>
    )
  }

  const activeRooms = rooms.filter(r => r.isActive).length
  const totalRoomUnits = rooms.reduce((sum, r) => sum + r.totalRooms, 0)

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-gray-900 mb-6">Dashboard</h1>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <p className="text-sm text-gray-500">Room Types</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{rooms.length}</p>
          <p className="text-xs text-gray-500 mt-1">{activeRooms} active &middot; {totalRoomUnits} total rooms</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <p className="text-sm text-gray-500">Total Bookings</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{totalBookings}</p>
          <p className="text-xs text-gray-500 mt-1">across all statuses</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <p className="text-sm text-gray-500">Pending Bookings</p>
          <p className="text-2xl font-bold text-yellow-600 mt-1">{pendingBookings.length}</p>
          <p className="text-xs text-gray-500 mt-1">awaiting confirmation</p>
        </div>
        <Link href="/affiliates" className="bg-white border border-gray-200 rounded-xl p-5 hover:border-primary-200 transition-colors">
          <p className="text-sm text-gray-500">Affiliates</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{totalAffiliates}</p>
          <p className="text-xs text-gray-500 mt-1">{pendingAffiliates} pending review</p>
        </Link>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Recent Pending Bookings */}
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900">Pending Bookings</h2>
            <Link href="/bookings" className="text-xs text-primary-600 hover:text-primary-700 font-medium">
              View all
            </Link>
          </div>
          {pendingBookings.length === 0 ? (
            <p className="text-sm text-gray-500">No pending bookings.</p>
          ) : (
            <div className="space-y-3">
              {pendingBookings.map((b) => (
                <Link
                  key={b.id}
                  href={`/bookings/${b.id}`}
                  className="flex items-center justify-between py-2 hover:bg-gray-50 -mx-2 px-2 rounded-lg transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-900">{b.guestFirstName} {b.guestLastName}</p>
                    <p className="text-xs text-gray-500">{b.roomName} &middot; {b.checkIn} &rarr; {b.checkOut}</p>
                  </div>
                  <span className="text-sm font-medium text-gray-900">{b.currency} {b.totalAmount.toFixed(2)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Room Types */}
        <div className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900">Room Types</h2>
            <Link href="/rooms" className="text-xs text-primary-600 hover:text-primary-700 font-medium">
              Manage
            </Link>
          </div>
          {rooms.length === 0 ? (
            <p className="text-sm text-gray-500">No room types yet.</p>
          ) : (
            <div className="space-y-3">
              {rooms.slice(0, 5).map((room) => (
                <Link
                  key={room.id}
                  href={`/rooms/${room.id}`}
                  className="flex items-center justify-between py-2 hover:bg-gray-50 -mx-2 px-2 rounded-lg transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-900">{room.name}</p>
                    <p className="text-xs text-gray-500">{room.bedType} &middot; {room.totalRooms} rooms</p>
                  </div>
                  <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                    room.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {room.isActive ? 'Active' : 'Inactive'}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
