'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { bookingsService, Booking } from '@/services/bookings'
import { roomsService, RoomType } from '@/services/rooms'

interface SearchResult {
  id: string
  label: string
  sublabel: string
  category: 'reservation' | 'room'
  href: string
}

export default function SearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [bookings, setBookings] = useState<Booking[]>([])
  const [rooms, setRooms] = useState<RoomType[]>([])
  const [loaded, setLoaded] = useState(false)

  // Load data when modal opens
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    setResults([])
    if (!loaded) {
      Promise.all([
        bookingsService.list({ limit: 500 }).then(r => r.bookings),
        roomsService.list(),
      ]).then(([b, r]) => {
        setBookings(b)
        setRooms(r)
        setLoaded(true)
      }).catch(console.error)
    }
    // Focus input after render
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open, loaded])

  // Filter results as user types
  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      setActiveIndex(0)
      return
    }
    const q = query.toLowerCase()
    const bookingResults: SearchResult[] = bookings
      .filter(b =>
        b.guestFirstName?.toLowerCase().includes(q) ||
        b.guestLastName?.toLowerCase().includes(q) ||
        `${b.guestFirstName} ${b.guestLastName}`.toLowerCase().includes(q) ||
        b.bookingReference?.toLowerCase().includes(q) ||
        b.guestEmail?.toLowerCase().includes(q) ||
        b.roomName?.toLowerCase().includes(q)
      )
      .slice(0, 5)
      .map(b => ({
        id: b.id,
        label: `${b.guestFirstName} ${b.guestLastName}`,
        sublabel: `${b.bookingReference} · ${b.roomName} · ${b.checkIn}`,
        category: 'reservation',
        href: `/bookings/${b.id}`,
      }))

    const roomResults: SearchResult[] = rooms
      .filter(r => r.name?.toLowerCase().includes(q) || r.category?.toLowerCase().includes(q))
      .slice(0, 5)
      .map(r => ({
        id: r.id,
        label: r.name,
        sublabel: `${r.category} · ${r.totalRooms} rooms · €${r.baseRate}/night`,
        category: 'room',
        href: `/rooms`,
      }))

    setResults([...bookingResults, ...roomResults])
    setActiveIndex(0)
  }, [query, bookings, rooms])

  const navigate = useCallback((result: SearchResult) => {
    onClose()
    router.push(result.href)
  }, [onClose, router])

  // Keyboard navigation
  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex(i => Math.min(i + 1, results.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex(i => Math.max(i - 1, 0))
      } else if (e.key === 'Enter' && results[activeIndex]) {
        e.preventDefault()
        navigate(results[activeIndex])
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, results, activeIndex, navigate, onClose])

  if (!open) return null

  const CATEGORY_LABELS: Record<string, string> = {
    reservation: 'Reservations',
    room: 'Room Types',
  }

  // Group results by category
  const grouped: { category: string; items: SearchResult[] }[] = []
  for (const r of results) {
    const group = grouped.find(g => g.category === r.category)
    if (group) group.items.push(r)
    else grouped.push({ category: r.category, items: [r] })
  }

  let globalIndex = 0

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[20vh]" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Modal */}
      <div
        className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 h-12 border-b border-gray-100">
          <svg className="w-4 h-4 text-gray-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search reservations, guests, rooms..."
            className="flex-1 text-sm text-gray-900 placeholder:text-gray-400 outline-none bg-transparent"
          />
          <kbd className="text-[10px] border border-gray-200 rounded px-1.5 py-0.5 bg-gray-50 text-gray-400 leading-none">ESC</kbd>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto">
          {query.trim() && results.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {grouped.map(group => (
            <div key={group.category}>
              <div className="px-4 pt-3 pb-1.5 text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
                {CATEGORY_LABELS[group.category] || group.category}
              </div>
              {group.items.map(item => {
                const idx = globalIndex++
                return (
                  <button
                    key={item.id}
                    onClick={() => navigate(item)}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${
                      idx === activeIndex ? 'bg-primary-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                      item.category === 'reservation' ? 'bg-blue-50 text-blue-500' : 'bg-emerald-50 text-emerald-500'
                    }`}>
                      {item.category === 'reservation' ? (
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                          <circle cx="9" cy="7" r="4" />
                        </svg>
                      ) : (
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                          <polyline points="9 22 9 12 15 12 15 22" />
                        </svg>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-gray-900 truncate">{item.label}</p>
                      <p className="text-[11px] text-gray-400 truncate">{item.sublabel}</p>
                    </div>
                    {idx === activeIndex && (
                      <kbd className="text-[10px] border border-gray-200 rounded px-1.5 py-0.5 bg-gray-50 text-gray-400 leading-none shrink-0">↵</kbd>
                    )}
                  </button>
                )
              })}
            </div>
          ))}

          {!query.trim() && (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              Start typing to search...
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
