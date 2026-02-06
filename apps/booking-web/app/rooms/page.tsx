'use client'

import Image from 'next/image'
import BookingNavigation from '@/components/layout/BookingNavigation'
import BookingFooter from '@/components/layout/BookingFooter'
import { MOCK_HOTEL } from '@/lib/mock/hotel'
import { MOCK_ROOMS } from '@/lib/mock/rooms'
import { formatCurrency } from '@/lib/utils'

export default function RoomsPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Mini Hero */}
      <div className="relative h-64 w-full">
        <Image
          src={MOCK_HOTEL.heroImage}
          alt={MOCK_HOTEL.name}
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-black/60" />
        <BookingNavigation />
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
          <h1 className="text-4xl md:text-5xl font-serif italic text-white mb-2">Our Rooms</h1>
          <p className="text-white/80 text-lg">Find your perfect alpine retreat</p>
        </div>
      </div>

      {/* Room Grid */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {MOCK_ROOMS.map((room) => (
            <div
              key={room.id}
              className="bg-white border border-gray-200 rounded-2xl overflow-hidden hover:shadow-lg transition-shadow group"
            >
              {/* Image */}
              <div className="relative h-64 overflow-hidden">
                <Image
                  src={room.images[0]}
                  alt={room.name}
                  fill
                  className="object-cover group-hover:scale-105 transition-transform duration-500"
                />
                {room.remainingRooms <= 3 && (
                  <div className="absolute top-3 left-3 bg-red-500 text-white text-xs font-bold px-2.5 py-1 rounded-full">
                    Only {room.remainingRooms} left
                  </div>
                )}
              </div>

              {/* Content */}
              <div className="p-6">
                <h3 className="text-xl font-bold text-gray-900 mb-1">{room.name}</h3>
                <p className="text-sm text-gray-500 mb-3">
                  {room.size} m&sup2; &middot; {room.bedType} &middot; Up to {room.maxOccupancy} guests
                </p>
                <p className="text-gray-600 text-sm mb-4">{room.shortDescription}</p>

                {/* Amenities */}
                <div className="flex flex-wrap gap-2 mb-5">
                  {room.amenities.slice(0, 4).map((amenity) => (
                    <span
                      key={amenity}
                      className="px-2.5 py-1 bg-gray-50 text-gray-600 rounded-md text-xs font-medium"
                    >
                      {amenity}
                    </span>
                  ))}
                  {room.amenities.length > 4 && (
                    <span className="px-2.5 py-1 text-primary-600 text-xs font-medium">
                      +{room.amenities.length - 4} more
                    </span>
                  )}
                </div>

                {/* Price + CTA */}
                <div className="flex items-end justify-between pt-4 border-t border-gray-100">
                  <div>
                    <p className="text-sm text-gray-500">From</p>
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-bold text-gray-900">
                        {formatCurrency(room.baseRate, room.currency)}
                      </span>
                      <span className="text-sm text-gray-500">/ night</span>
                    </div>
                  </div>
                  <a
                    href={`/availability?room=${room.id}`}
                    className="px-6 py-2.5 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-sm"
                  >
                    Check Availability
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <BookingFooter />
    </div>
  )
}
