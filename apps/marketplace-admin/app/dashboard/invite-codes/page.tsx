'use client'

import { useState, useEffect } from 'react'
import { inviteCodesService, type InviteCode, type InviteData } from '@/services/api/inviteCodes'
import { TrashIcon, ClipboardIcon, CheckIcon, PlusIcon, ArrowLeftIcon } from '@heroicons/react/24/outline'

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'IDR', 'THB', 'AUD', 'CAD', 'JPY', 'SGD']

const DEFAULT_PROPERTY = {
  property_name: '', city: '', country: '', address: '',
  reservation_email: '', phone_number: '', whatsapp_number: '',
  instagram: '', facebook: '',
  default_currency: 'EUR', default_language: 'en',
  supported_currencies: [] as string[], supported_languages: [] as string[],
}

const DEFAULT_BRANDING = {
  hero_image: '', primary_color: '#4F46E5', accent_color: '#F5F3EF',
  font_pairing: 'high-end-serif', description: '',
  booking_filters: ['includeBreakfast', 'freeCancellation', 'payAtHotel'],
}

const DEFAULT_ROOM = {
  name: '', beds: [{ type: 'King Bed', count: 1 }],
  maxOccupancy: 2, bedrooms: 1, bathrooms: 1, roomSize: '', totalRooms: 1,
  description: '', category: 'Standard',
  baseRate: '', nonRefundableRate: '', nonRefundableDiscount: 10,
  flexibleRateEnabled: true, nonRefundableEnabled: false,
  cancellationPolicy: 'Free until 7 days before', currency: 'EUR',
  images: [] as string[], amenities: [] as string[], features: [] as string[],
  bookDirectBenefits: [] as string[],
  operatingPeriods: [{ from: '2026-01-01', to: '2026-12-31' }],
  seasons: [] as { name: string; tier: string; from: string; to: string; rate: string; minStay: number }[],
  weekendSurcharge: '+0%',
}

const DEFAULT_POLICIES = {
  check_in_time: '15:00', check_out_time: '11:00', minimum_stay: 1,
  pay_at_property: true, online_card_payment: false, bank_transfer: false,
  special_requests: true, arrival_time: false, guest_count: false, refer_a_guest: false,
}

export default function InviteCodesPage() {
  const [view, setView] = useState<'list' | 'create'>('list')
  const [invites, setInvites] = useState<InviteCode[]>([])
  const [loading, setLoading] = useState(true)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Create form state
  const [property, setProperty] = useState({ ...DEFAULT_PROPERTY })
  const [branding, setBranding] = useState({ ...DEFAULT_BRANDING })
  const [rooms, setRooms] = useState([{ ...DEFAULT_ROOM }])
  const [policies, setPolicies] = useState({ ...DEFAULT_POLICIES })
  const [saving, setSaving] = useState(false)
  const [generatedCode, setGeneratedCode] = useState<string | null>(null)

  useEffect(() => {
    loadInvites()
  }, [])

  const loadInvites = async () => {
    try {
      const data = await inviteCodesService.list()
      setInvites(data)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  const handleCopy = (code: string, id: string) => {
    navigator.clipboard.writeText(code)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this invite code?')) return
    await inviteCodesService.delete(id)
    setInvites(prev => prev.filter(i => i.id !== id))
  }

  const handleCreate = async () => {
    if (!property.property_name.trim()) return
    try {
      setSaving(true)
      const data: InviteData = { property, branding, rooms, policies }
      const result = await inviteCodesService.create(data)
      setGeneratedCode(result.code)
      loadInvites()
    } catch {
      alert('Failed to create invite code')
    } finally {
      setSaving(false)
    }
  }

  const resetForm = () => {
    setProperty({ ...DEFAULT_PROPERTY })
    setBranding({ ...DEFAULT_BRANDING })
    setRooms([{ ...DEFAULT_ROOM }])
    setPolicies({ ...DEFAULT_POLICIES })
    setGeneratedCode(null)
    setView('list')
  }

  const updateRoom = (index: number, updates: Partial<typeof DEFAULT_ROOM>) => {
    setRooms(prev => prev.map((r, i) => i === index ? { ...r, ...updates } : r))
  }

  if (view === 'create') {
    if (generatedCode) {
      return (
        <div className="p-6 flex items-center justify-center min-h-[80vh]">
          <div className="bg-white rounded-xl border border-gray-200 p-8 max-w-md w-full text-center">
            <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckIcon className="w-7 h-7 text-green-600" />
            </div>
            <h2 className="text-lg font-bold text-gray-900 mb-1">Invite Code Created</h2>
            <p className="text-sm text-gray-500 mb-6">Share this code with the hotel owner</p>
            <div className="bg-gray-50 rounded-lg border border-gray-200 p-4 mb-6">
              <p className="text-3xl font-mono font-bold text-gray-900 tracking-widest">{generatedCode}</p>
            </div>
            <button
              onClick={() => { navigator.clipboard.writeText(generatedCode); }}
              className="w-full mb-3 py-2.5 bg-primary-500 text-white text-sm font-semibold rounded-lg hover:bg-primary-600 transition-colors"
            >
              Copy Code
            </button>
            <button
              onClick={resetForm}
              className="w-full py-2.5 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
            >
              Back to List
            </button>
          </div>
        </div>
      )
    }

    return (
      <div>
        <header className="bg-white border-b border-gray-200">
          <div className="px-6 py-4 flex items-center gap-3">
            <button onClick={resetForm} className="p-1 text-gray-400 hover:text-gray-600 rounded-md">
              <ArrowLeftIcon className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-xl font-bold text-gray-900">Create Invite</h1>
              <p className="text-sm text-gray-500">Pre-configure a hotel setup for onboarding</p>
            </div>
          </div>
        </header>

        <div className="p-6 max-w-3xl space-y-6">

          {/* Property Details */}
          <Section title="Property Details">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Hotel Name *" value={property.property_name} onChange={v => setProperty(p => ({ ...p, property_name: v }))} placeholder="e.g. Hotel Alpenrose" />
              <Field label="City *" value={property.city} onChange={v => setProperty(p => ({ ...p, city: v }))} placeholder="e.g. Innsbruck" />
              <Field label="Country *" value={property.country} onChange={v => setProperty(p => ({ ...p, country: v }))} placeholder="e.g. Austria" />
              <Field label="Address" value={property.address} onChange={v => setProperty(p => ({ ...p, address: v }))} placeholder="Full address" />
              <Field label="Reservation Email" value={property.reservation_email} onChange={v => setProperty(p => ({ ...p, reservation_email: v }))} placeholder="reservations@hotel.com" />
              <Field label="Phone" value={property.phone_number} onChange={v => setProperty(p => ({ ...p, phone_number: v }))} placeholder="+43 512 123 456" />
              <Field label="WhatsApp" value={property.whatsapp_number} onChange={v => setProperty(p => ({ ...p, whatsapp_number: v }))} placeholder="+43 512 123 456" />
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Currency</label>
                <select
                  value={property.default_currency}
                  onChange={e => setProperty(p => ({ ...p, default_currency: e.target.value }))}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <Field label="Instagram" value={property.instagram} onChange={v => setProperty(p => ({ ...p, instagram: v }))} placeholder="https://instagram.com/..." />
              <Field label="Facebook" value={property.facebook} onChange={v => setProperty(p => ({ ...p, facebook: v }))} placeholder="https://facebook.com/..." />
            </div>
          </Section>

          {/* Branding */}
          <Section title="Branding">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Hero Image URL" value={branding.hero_image} onChange={v => setBranding(b => ({ ...b, hero_image: v }))} placeholder="https://images.unsplash.com/..." />
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Primary Color</label>
                <div className="flex gap-2">
                  <input type="color" value={branding.primary_color} onChange={e => setBranding(b => ({ ...b, primary_color: e.target.value }))} className="w-8 h-8 rounded cursor-pointer border-0" />
                  <input type="text" value={branding.primary_color} onChange={e => setBranding(b => ({ ...b, primary_color: e.target.value }))} className="flex-1 px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500" />
                </div>
              </div>
              <div className="col-span-2">
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Description</label>
                <textarea
                  value={branding.description}
                  onChange={e => setBranding(b => ({ ...b, description: e.target.value }))}
                  rows={2}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                  placeholder="A short description of the hotel..."
                />
              </div>
            </div>
          </Section>

          {/* Rooms */}
          <Section title="Room Types">
            {rooms.map((room, idx) => (
              <div key={idx} className="border border-gray-200 rounded-lg p-4 mb-3">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-[13px] font-semibold text-gray-900">Room {idx + 1}</h4>
                  {rooms.length > 1 && (
                    <button onClick={() => setRooms(prev => prev.filter((_, i) => i !== idx))} className="text-red-500 text-[12px] hover:underline">Remove</button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Name *" value={room.name} onChange={v => updateRoom(idx, { name: v })} placeholder="e.g. Deluxe Double Room" />
                  <div>
                    <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Category</label>
                    <select
                      value={room.category}
                      onChange={e => updateRoom(idx, { category: e.target.value })}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                    >
                      {['Standard', 'Deluxe', 'Superior', 'Suite', 'Villa', 'Bungalow', 'Studio', 'Penthouse'].map(c => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                  <Field label="Base Rate" value={room.baseRate} onChange={v => updateRoom(idx, { baseRate: v })} placeholder="e.g. 120" type="number" />
                  <Field label="Total Rooms" value={String(room.totalRooms)} onChange={v => updateRoom(idx, { totalRooms: parseInt(v) || 1 })} type="number" />
                  <Field label="Max Occupancy" value={String(room.maxOccupancy)} onChange={v => updateRoom(idx, { maxOccupancy: parseInt(v) || 2 })} type="number" />
                  <Field label="Size (m²)" value={room.roomSize} onChange={v => updateRoom(idx, { roomSize: v })} placeholder="e.g. 28" />
                  <div className="col-span-2">
                    <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Description</label>
                    <textarea
                      value={room.description}
                      onChange={e => updateRoom(idx, { description: e.target.value })}
                      rows={2}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
                      placeholder="Room description..."
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Amenities (comma-separated)</label>
                    <input
                      type="text"
                      value={room.amenities.join(', ')}
                      onChange={e => updateRoom(idx, { amenities: e.target.value.split(',').map(a => a.trim()).filter(Boolean) })}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500"
                      placeholder="Free WiFi, Mini Bar, Air Conditioning, ..."
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Features (comma-separated)</label>
                    <input
                      type="text"
                      value={room.features.join(', ')}
                      onChange={e => updateRoom(idx, { features: e.target.value.split(',').map(f => f.trim()).filter(Boolean) })}
                      className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500"
                      placeholder="Mountain View, Balcony, Private Terrace, ..."
                    />
                  </div>
                </div>
              </div>
            ))}
            <button
              onClick={() => setRooms(prev => [...prev, { ...DEFAULT_ROOM, currency: property.default_currency }])}
              className="inline-flex items-center gap-1.5 text-[12px] text-primary-600 font-medium hover:underline"
            >
              <PlusIcon className="w-3.5 h-3.5" /> Add Room Type
            </button>
          </Section>

          {/* Policies */}
          <Section title="Policies & Operations">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Check-in Time</label>
                <select
                  value={policies.check_in_time}
                  onChange={e => setPolicies(p => ({ ...p, check_in_time: e.target.value }))}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`).map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Check-out Time</label>
                <select
                  value={policies.check_out_time}
                  onChange={e => setPolicies(p => ({ ...p, check_out_time: e.target.value }))}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                >
                  {Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`).map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
            </div>
            <div className="flex flex-wrap gap-4 mt-3">
              <Toggle label="Pay at Hotel" checked={policies.pay_at_property} onChange={v => setPolicies(p => ({ ...p, pay_at_property: v }))} />
              <Toggle label="Online Card" checked={policies.online_card_payment} onChange={v => setPolicies(p => ({ ...p, online_card_payment: v }))} />
              <Toggle label="Bank Transfer" checked={policies.bank_transfer} onChange={v => setPolicies(p => ({ ...p, bank_transfer: v }))} />
            </div>
          </Section>

          {/* Generate button */}
          <button
            onClick={handleCreate}
            disabled={saving || !property.property_name.trim()}
            className="w-full py-3 bg-primary-500 text-white text-sm font-semibold rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Generating...' : 'Generate Invite Code'}
          </button>
        </div>
      </div>
    )
  }

  // ── List View ──

  return (
    <div>
      <header className="bg-white border-b border-gray-200">
        <div className="px-6 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Invite Codes</h1>
            <p className="text-sm text-gray-500">Pre-configure hotel setups for onboarding</p>
          </div>
          <button
            onClick={() => setView('create')}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-500 text-white text-sm font-semibold rounded-lg hover:bg-primary-600 transition-colors"
          >
            <PlusIcon className="w-4 h-4" /> Create Invite
          </button>
        </div>
      </header>

      <div className="p-6">
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : invites.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-lg border border-gray-200">
            <p className="text-gray-500 text-sm">No invite codes yet</p>
            <p className="text-gray-400 text-xs mt-1">Create one to pre-configure a hotel setup</p>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Code</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Hotel</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Created</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Expires</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {invites.map(inv => (
                  <tr key={inv.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono font-semibold text-gray-900">{inv.code}</td>
                    <td className="px-4 py-3 text-gray-700">{inv.hotel_name || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
                        inv.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                        inv.status === 'redeemed' ? 'bg-green-100 text-green-800' :
                        'bg-gray-100 text-gray-600'
                      }`}>
                        {inv.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{new Date(inv.created_at).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-gray-500">{new Date(inv.expires_at).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleCopy(inv.code, inv.id)}
                          className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100"
                          title="Copy code"
                        >
                          {copiedId === inv.id ? <CheckIcon className="w-4 h-4 text-green-500" /> : <ClipboardIcon className="w-4 h-4" />}
                        </button>
                        <button
                          onClick={() => handleDelete(inv.id)}
                          className="p-1.5 text-gray-400 hover:text-red-500 rounded-md hover:bg-red-50"
                          title="Delete"
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Helper Components ──

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <h3 className="text-[14px] font-semibold text-gray-900 mb-3">{title}</h3>
      {children}
    </div>
  )
}

function Field({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string
}) {
  return (
    <div>
      <label className="block text-[12px] font-medium text-gray-700 mb-0.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        placeholder={placeholder}
      />
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative w-8 h-[18px] rounded-full transition-colors ${checked ? 'bg-primary-500' : 'bg-gray-300'}`}
      >
        <span className={`absolute top-[2px] left-[2px] w-[14px] h-[14px] bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-[14px]' : ''}`} />
      </button>
      <span className="text-[12px] text-gray-700">{label}</span>
    </label>
  )
}
