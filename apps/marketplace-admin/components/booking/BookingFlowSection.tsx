'use client'

import { useState, useEffect } from 'react'
import {
  PlusIcon,
  PencilSquareIcon,
  TrashIcon,
  XMarkIcon,
  CheckIcon,
} from '@heroicons/react/24/outline'
import { bookingSettingsService, type AddonItem, type AddonSettings, type DesignSettings, type PromoCodeItem } from '@/services/booking'

type Tab = 'filters' | 'addons' | 'promos' | 'benefits' | 'payment'

const CATEGORIES = [
  { value: 'dining', label: 'Dining' },
  { value: 'experience', label: 'Experience' },
  { value: 'transport', label: 'Transport' },
  { value: 'wellness', label: 'Wellness' },
]

const CATEGORY_COLORS: Record<string, string> = {
  transport: 'bg-blue-100 text-blue-700',
  wellness: 'bg-purple-100 text-purple-700',
  dining: 'bg-orange-100 text-orange-700',
  experience: 'bg-green-100 text-green-700',
}

const AVAILABLE_FILTERS = [
  { key: 'includeBreakfast', label: 'Include Breakfast' },
  { key: 'freeCancellation', label: 'Free Cancellation' },
  { key: 'payAtHotel', label: 'Pay at Hotel' },
  { key: 'bestRated', label: 'Best Rated' },
  { key: 'mountainView', label: 'Mountain View' },
]

const BENEFIT_OPTIONS = [
  'Welcome Drink on Arrival',
  '10% Spa Discount',
  'Late Check-out (subject to availability)',
  'Early Check-in (subject to availability)',
  'Free Airport Transfer',
  'Daily Breakfast Included',
  'Room Upgrade (subject to availability)',
]

const emptyAddon = {
  name: '',
  description: '',
  price: 0,
  currency: 'EUR',
  category: 'experience',
  image: '',
  duration: '',
  perPerson: false,
}

export default function BookingFlowSection({ hotelId }: { hotelId: string }) {
  const [activeTab, setActiveTab] = useState<Tab>('addons')
  const [loading, setLoading] = useState(true)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  // Add-ons state
  const [addons, setAddons] = useState<AddonItem[]>([])
  const [addonSettings, setAddonSettings] = useState<AddonSettings>({ showAddonsStep: true, groupAddonsByCategory: true })
  const [showModal, setShowModal] = useState(false)
  const [editingAddon, setEditingAddon] = useState<AddonItem | null>(null)
  const [formData, setFormData] = useState(emptyAddon)
  const [savingAddon, setSavingAddon] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Filters state
  const [bookingFilters, setBookingFilters] = useState<string[]>([])
  const [savingFilters, setSavingFilters] = useState(false)

  // Benefits state
  const [benefits, setBenefits] = useState<string[]>([])
  const [benefitInput, setBenefitInput] = useState('')
  const [savingBenefits, setSavingBenefits] = useState(false)

  // Promo codes state
  const [promoCodes, setPromoCodes] = useState<PromoCodeItem[]>([])
  const [showPromoModal, setShowPromoModal] = useState(false)
  const [editingPromo, setEditingPromo] = useState<PromoCodeItem | null>(null)
  const [promoFormData, setPromoFormData] = useState({
    code: '', discountType: 'percentage' as const, discountValue: 0,
    validFrom: '', validUntil: '', isActive: true, maxUses: null as number | null,
  })
  const [savingPromo, setSavingPromo] = useState(false)

  useEffect(() => {
    Promise.all([
      bookingSettingsService.listAddons(hotelId).catch(() => []),
      bookingSettingsService.getAddonSettings(hotelId).catch(() => ({ showAddonsStep: true, groupAddonsByCategory: true })),
      bookingSettingsService.getDesignSettings(hotelId).catch(() => ({ booking_filters: [] } as DesignSettings)),
      bookingSettingsService.getBenefits(hotelId).catch(() => ({ benefits: [] })),
      bookingSettingsService.listPromoCodes(hotelId).catch(() => []),
    ]).then(([addonList, settings, design, benefitsData, promoList]) => {
      setAddons(addonList)
      setAddonSettings(settings)
      if (design.booking_filters) setBookingFilters(design.booking_filters)
      setBenefits(benefitsData.benefits || [])
      setPromoCodes(promoList)
    }).finally(() => setLoading(false))
  }, [hotelId])

  const showFeedback = (type: 'success' | 'error', message: string) => {
    setFeedback({ type, message })
    setTimeout(() => setFeedback(null), 3000)
  }

  // ── Add-on handlers ──
  const openCreateModal = () => { setEditingAddon(null); setFormData({ ...emptyAddon }); setShowModal(true) }
  const openEditModal = (addon: AddonItem) => {
    setEditingAddon(addon)
    setFormData({ name: addon.name, description: addon.description || '', price: addon.price, currency: addon.currency, category: addon.category, image: addon.image || '', duration: addon.duration || '', perPerson: addon.perPerson || false })
    setShowModal(true)
  }
  const handleSaveAddon = async () => {
    setSavingAddon(true)
    try {
      if (editingAddon) {
        const updated = await bookingSettingsService.updateAddon(hotelId, editingAddon.id, formData)
        setAddons(prev => prev.map(a => a.id === editingAddon.id ? updated : a))
        showFeedback('success', 'Add-on updated')
      } else {
        const created = await bookingSettingsService.createAddon(hotelId, formData as Omit<AddonItem, 'id'>)
        setAddons(prev => [...prev, created])
        showFeedback('success', 'Add-on created')
      }
      setShowModal(false)
    } catch { showFeedback('error', 'Failed to save add-on') }
    finally { setSavingAddon(false) }
  }
  const handleDeleteAddon = async (id: string) => {
    if (!confirm('Delete this add-on?')) return
    setDeletingId(id)
    try {
      await bookingSettingsService.deleteAddon(hotelId, id)
      setAddons(prev => prev.filter(a => a.id !== id))
      showFeedback('success', 'Add-on deleted')
    } catch { showFeedback('error', 'Failed to delete') }
    finally { setDeletingId(null) }
  }
  const handleToggleAddonSetting = async (key: keyof AddonSettings) => {
    const updated = { ...addonSettings, [key]: !addonSettings[key] }
    setAddonSettings(updated)
    try { await bookingSettingsService.updateAddonSettings(hotelId, { [key]: updated[key] }) }
    catch { setAddonSettings(addonSettings) }
  }

  // ── Filter handlers ──
  const handleToggleFilter = (key: string) => {
    setBookingFilters(prev => prev.includes(key) ? prev.filter(f => f !== key) : [...prev, key])
  }
  const handleSaveFilters = async () => {
    setSavingFilters(true)
    try {
      await bookingSettingsService.updateDesignSettings(hotelId, { booking_filters: bookingFilters })
      showFeedback('success', 'Filters saved')
    } catch { showFeedback('error', 'Failed to save filters') }
    finally { setSavingFilters(false) }
  }

  // ── Benefits handlers ──
  const addCustomBenefit = () => {
    const trimmed = benefitInput.trim()
    if (trimmed && !benefits.includes(trimmed)) setBenefits([...benefits, trimmed])
    setBenefitInput('')
  }
  const handleSaveBenefits = async () => {
    setSavingBenefits(true)
    const trimmed = benefitInput.trim()
    let finalBenefits = benefits
    if (trimmed && !benefits.includes(trimmed)) {
      finalBenefits = [...benefits, trimmed]
      setBenefits(finalBenefits)
      setBenefitInput('')
    }
    try {
      await bookingSettingsService.updateBenefits(hotelId, finalBenefits)
      showFeedback('success', 'Benefits saved')
    } catch { showFeedback('error', 'Failed to save benefits') }
    finally { setSavingBenefits(false) }
  }

  // ── Promo code handlers ──
  const openCreatePromoModal = () => {
    setEditingPromo(null)
    setPromoFormData({ code: '', discountType: 'percentage', discountValue: 0, validFrom: '', validUntil: '', isActive: true, maxUses: null })
    setShowPromoModal(true)
  }
  const openEditPromoModal = (promo: PromoCodeItem) => {
    setEditingPromo(promo)
    setPromoFormData({ code: promo.code, discountType: promo.discountType, discountValue: promo.discountValue, validFrom: promo.validFrom || '', validUntil: promo.validUntil || '', isActive: promo.isActive, maxUses: promo.maxUses ?? null })
    setShowPromoModal(true)
  }
  const handleSavePromoCode = async () => {
    setSavingPromo(true)
    try {
      if (editingPromo) {
        const updated = await bookingSettingsService.updatePromoCode(hotelId, editingPromo.id, promoFormData)
        setPromoCodes(prev => prev.map(p => p.id === editingPromo.id ? updated : p))
        showFeedback('success', 'Promo code updated')
      } else {
        const created = await bookingSettingsService.createPromoCode(hotelId, promoFormData as any)
        setPromoCodes(prev => [...prev, created])
        showFeedback('success', 'Promo code created')
      }
      setShowPromoModal(false)
    } catch { showFeedback('error', 'Failed to save promo code') }
    finally { setSavingPromo(false) }
  }
  const handleDeletePromoCode = async (id: string) => {
    if (!confirm('Delete this promo code?')) return
    try {
      await bookingSettingsService.deletePromoCode(hotelId, id)
      setPromoCodes(prev => prev.filter(p => p.id !== id))
      showFeedback('success', 'Promo code deleted')
    } catch { showFeedback('error', 'Failed to delete') }
  }

  const tabs = [
    { id: 'filters' as const, label: 'Filters' },
    { id: 'addons' as const, label: 'Add-ons' },
    { id: 'promos' as const, label: 'Promos' },
    { id: 'benefits' as const, label: 'Benefits' },
    { id: 'payment' as const, label: 'Payment' },
  ]

  if (loading) return <div className="animate-pulse h-64 bg-gray-200 rounded-lg" />

  return (
    <div>
      {/* Tab bar */}
      <div className="bg-gray-100 rounded-lg p-1 grid grid-cols-5 shrink-0 max-w-xl mb-4">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center justify-center py-1.5 rounded-md text-[12px] transition-all ${
              activeTab === tab.id ? 'bg-white text-gray-900 font-semibold shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {feedback && (
        <div className={`mb-4 p-3 rounded-lg text-sm ${feedback.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
          {feedback.message}
        </div>
      )}

      {/* ═══ FILTERS TAB ═══ */}
      {activeTab === 'filters' && (
        <div className="max-w-2xl">
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <h2 className="text-[14px] font-semibold text-gray-900">Room Filters</h2>
            <p className="text-[12px] text-gray-500 mt-0.5 mb-4">Choose which filters guests can use to narrow room results</p>
            <div className="space-y-2">
              {AVAILABLE_FILTERS.map((f) => {
                const active = bookingFilters.includes(f.key)
                return (
                  <button key={f.key} type="button" onClick={() => handleToggleFilter(f.key)}
                    className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all text-left ${active ? 'border-primary-500 bg-primary-50/30' : 'border-gray-200 hover:border-gray-300'}`}>
                    <span className="text-[13px] font-medium text-gray-900">{f.label}</span>
                    <div className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${active ? 'bg-primary-500' : 'bg-gray-300'}`}>
                      <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${active ? 'left-4' : 'left-0.5'}`} />
                    </div>
                  </button>
                )
              })}
            </div>
            <div className="flex justify-end mt-4">
              <button onClick={handleSaveFilters} disabled={savingFilters} className="px-4 py-2 text-[13px] font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors">
                {savingFilters ? 'Saving...' : 'Save Filters'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ ADDONS TAB ═══ */}
      {activeTab === 'addons' && (
        <div className="max-w-2xl space-y-4">
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-[14px] font-semibold text-gray-900">Guest Add-ons</h2>
                <p className="text-[12px] text-gray-500 mt-0.5">Upsell experiences and services to your guests</p>
              </div>
              <button onClick={openCreateModal} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors">
                <PlusIcon className="w-3.5 h-3.5" /> Add
              </button>
            </div>
            {addons.length === 0 ? (
              <div className="bg-gray-50 rounded-lg border border-gray-200 p-8 text-center">
                <p className="text-[13px] text-gray-500">No add-ons yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {addons.map((addon) => (
                  <div key={addon.id} className="flex items-center gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-gray-900">{addon.name}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${CATEGORY_COLORS[addon.category] || 'bg-gray-100 text-gray-600'}`}>{addon.category}</span>
                      </div>
                      <p className="text-[12px] text-gray-500 mt-0.5">{addon.currency} {addon.price}{addon.perPerson ? ' /person' : ''}</p>
                    </div>
                    <button onClick={() => openEditModal(addon)} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100 transition-colors"><PencilSquareIcon className="w-4 h-4" /></button>
                    <button onClick={() => handleDeleteAddon(addon.id)} disabled={deletingId === addon.id} className="p-1.5 text-gray-400 hover:text-red-500 rounded-md hover:bg-red-50 transition-colors disabled:opacity-50"><TrashIcon className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* Display Settings */}
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <h3 className="text-[13px] font-semibold text-gray-900 mb-3">Display Settings</h3>
            <div className="space-y-2">
              {[{ key: 'showAddonsStep' as const, label: 'Show Add-ons Step', desc: 'Show add-ons page in booking flow' },
                { key: 'groupAddonsByCategory' as const, label: 'Group by Category', desc: 'Organize add-ons by category' }].map(s => (
                <button key={s.key} type="button" onClick={() => handleToggleAddonSetting(s.key)}
                  className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all text-left ${addonSettings[s.key] ? 'border-primary-500 bg-primary-50/30' : 'border-gray-200'}`}>
                  <div><span className="text-[13px] font-medium text-gray-900">{s.label}</span><p className="text-[11px] text-gray-500 mt-0.5">{s.desc}</p></div>
                  <div className={`w-9 h-5 rounded-full transition-colors relative shrink-0 ${addonSettings[s.key] ? 'bg-primary-500' : 'bg-gray-300'}`}>
                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${addonSettings[s.key] ? 'left-4' : 'left-0.5'}`} />
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ═══ PROMOS TAB ═══ */}
      {activeTab === 'promos' && (
        <div className="max-w-2xl">
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-[14px] font-semibold text-gray-900">Promo Codes</h2>
                <p className="text-[12px] text-gray-500 mt-0.5">Create discount codes for your guests</p>
              </div>
              <button onClick={openCreatePromoModal} className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors">
                <PlusIcon className="w-3.5 h-3.5" /> Add
              </button>
            </div>
            {promoCodes.length === 0 ? (
              <div className="bg-gray-50 rounded-lg border border-gray-200 p-8 text-center">
                <p className="text-[13px] text-gray-500">No promo codes yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {promoCodes.map((promo) => (
                  <div key={promo.id} className="flex items-center gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-mono font-bold text-gray-900">{promo.code}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${promo.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{promo.isActive ? 'Active' : 'Inactive'}</span>
                      </div>
                      <p className="text-[12px] text-gray-500 mt-0.5">{promo.discountType === 'percentage' ? `${promo.discountValue}% off` : `$${promo.discountValue} off`} · {promo.useCount} uses</p>
                    </div>
                    <button onClick={() => openEditPromoModal(promo)} className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100 transition-colors"><PencilSquareIcon className="w-4 h-4" /></button>
                    <button onClick={() => handleDeletePromoCode(promo.id)} className="p-1.5 text-gray-400 hover:text-red-500 rounded-md hover:bg-red-50 transition-colors"><TrashIcon className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ BENEFITS TAB ═══ */}
      {activeTab === 'benefits' && (
        <div className="max-w-2xl">
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <h2 className="text-[14px] font-semibold text-gray-900">Book Direct Benefits</h2>
            <p className="text-[12px] text-gray-500 mt-0.5 mb-4">Encourage guests to book directly. These appear in the room detail modal.</p>
            <div className="space-y-2 mb-4">
              {BENEFIT_OPTIONS.map((benefit) => {
                const isSelected = benefits.includes(benefit)
                return (
                  <button key={benefit} type="button" onClick={() => isSelected ? setBenefits(benefits.filter(b => b !== benefit)) : setBenefits([...benefits, benefit])}
                    className={`w-full flex items-center gap-3 px-4 py-2 rounded-lg border text-left transition-colors ${isSelected ? 'border-primary-300 bg-primary-50/30' : 'border-gray-200 bg-gray-50 hover:bg-gray-100'}`}>
                    <div className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center ${isSelected ? 'border-primary-500 bg-primary-500' : 'border-gray-300'}`}>
                      {isSelected && <CheckIcon className="w-2 h-2 text-white" />}
                    </div>
                    <span className="text-[12px] text-gray-700">{benefit}</span>
                  </button>
                )
              })}
            </div>
            <div className="mb-4">
              <label className="block text-[11px] text-gray-500 mb-1.5">Custom Benefit <span className="text-gray-400">(optional)</span></label>
              <input type="text" value={benefitInput} onChange={(e) => setBenefitInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomBenefit() } }}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900" placeholder="e.g. Complimentary sunset cocktail" />
            </div>
            {benefits.filter(b => !BENEFIT_OPTIONS.includes(b)).length > 0 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {benefits.filter(b => !BENEFIT_OPTIONS.includes(b)).map((b, i) => (
                  <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 bg-primary-50 text-primary-700 text-[11px] font-medium rounded-full border border-primary-200">
                    {b} <button type="button" onClick={() => setBenefits(benefits.filter(x => x !== b))} className="text-primary-400 hover:text-primary-600"><XMarkIcon className="w-3 h-3" /></button>
                  </span>
                ))}
              </div>
            )}
            <button onClick={handleSaveBenefits} disabled={savingBenefits} className="px-4 py-2 text-[13px] font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors">
              {savingBenefits ? 'Saving...' : 'Save Benefits'}
            </button>
          </div>
        </div>
      )}

      {/* ═══ PAYMENT TAB ═══ */}
      {activeTab === 'payment' && (
        <PaymentTab hotelId={hotelId} showFeedback={showFeedback} />
      )}

      {/* ═══ ADD/EDIT ADDON MODAL ═══ */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-[15px] font-semibold text-gray-900">{editingAddon ? 'Edit Add-on' : 'Create Add-on'}</h3>
              <button onClick={() => setShowModal(false)} className="p-1 text-gray-400 hover:text-gray-600 rounded-md"><XMarkIcon className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-3">
              <div><label className="block text-[12px] font-medium text-gray-700 mb-0.5">Name *</label><input type="text" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500" placeholder="e.g., Airport Transfer" /></div>
              <div><label className="block text-[12px] font-medium text-gray-700 mb-0.5">Description</label><textarea value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} rows={2} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-[12px] font-medium text-gray-700 mb-0.5">Price *</label><input type="number" min={0} step={0.01} value={formData.price} onChange={(e) => setFormData({ ...formData, price: Number(e.target.value) })} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500" /></div>
                <div><label className="block text-[12px] font-medium text-gray-700 mb-0.5">Category</label><select value={formData.category} onChange={(e) => setFormData({ ...formData, category: e.target.value })} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500">{CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></div>
              </div>
              <div><label className="block text-[12px] font-medium text-gray-700 mb-0.5">Duration</label><input type="text" value={formData.duration} onChange={(e) => setFormData({ ...formData, duration: e.target.value })} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500" placeholder="e.g., 60 min" /></div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={formData.perPerson} onChange={(e) => setFormData({ ...formData, perPerson: e.target.checked })} className="rounded border-gray-300 text-primary-600 focus:ring-primary-500" /><span className="text-[12px] text-gray-700">Per person pricing</span></label>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-gray-200">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 text-[13px] text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
              <button onClick={handleSaveAddon} disabled={savingAddon || !formData.name.trim()} className="px-4 py-2 text-[13px] font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50">{savingAddon ? 'Saving...' : editingAddon ? 'Save' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ ADD/EDIT PROMO MODAL ═══ */}
      {showPromoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowPromoModal(false)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-[15px] font-semibold text-gray-900">{editingPromo ? 'Edit Promo Code' : 'Create Promo Code'}</h3>
              <button onClick={() => setShowPromoModal(false)} className="p-1 text-gray-400 hover:text-gray-600 rounded-md"><XMarkIcon className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-3">
              <div><label className="block text-[12px] font-medium text-gray-700 mb-0.5">Code *</label><input type="text" value={promoFormData.code} onChange={(e) => setPromoFormData({ ...promoFormData, code: e.target.value.toUpperCase() })} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] font-mono focus:outline-none focus:ring-2 focus:ring-primary-500" placeholder="e.g., SUMMER20" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-[12px] font-medium text-gray-700 mb-0.5">Type</label><select value={promoFormData.discountType} onChange={(e) => setPromoFormData({ ...promoFormData, discountType: e.target.value as 'percentage' | 'fixed' })} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500"><option value="percentage">Percentage (%)</option><option value="fixed">Fixed Amount ($)</option></select></div>
                <div><label className="block text-[12px] font-medium text-gray-700 mb-0.5">Value *</label><input type="number" min={0} max={promoFormData.discountType === 'percentage' ? 100 : undefined} step={promoFormData.discountType === 'percentage' ? 1 : 0.01} value={promoFormData.discountValue} onChange={(e) => setPromoFormData({ ...promoFormData, discountValue: Number(e.target.value) })} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="block text-[12px] font-medium text-gray-700 mb-0.5">Valid From</label><input type="date" value={promoFormData.validFrom} onChange={(e) => setPromoFormData({ ...promoFormData, validFrom: e.target.value || '' })} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500" /></div>
                <div><label className="block text-[12px] font-medium text-gray-700 mb-0.5">Valid Until</label><input type="date" value={promoFormData.validUntil} onChange={(e) => setPromoFormData({ ...promoFormData, validUntil: e.target.value || '' })} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500" /></div>
              </div>
              <div><label className="block text-[12px] font-medium text-gray-700 mb-0.5">Max Uses</label><input type="number" min={0} value={promoFormData.maxUses ?? ''} onChange={(e) => setPromoFormData({ ...promoFormData, maxUses: e.target.value ? Number(e.target.value) : null })} className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500" placeholder="Unlimited" /></div>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={promoFormData.isActive} onChange={(e) => setPromoFormData({ ...promoFormData, isActive: e.target.checked })} className="rounded border-gray-300 text-primary-600 focus:ring-primary-500" /><span className="text-[12px] text-gray-700">Active</span></label>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-gray-200">
              <button onClick={() => setShowPromoModal(false)} className="px-4 py-2 text-[13px] text-gray-700 hover:bg-gray-100 rounded-lg">Cancel</button>
              <button onClick={handleSavePromoCode} disabled={savingPromo || !promoFormData.code.trim() || !promoFormData.discountValue} className="px-4 py-2 text-[13px] font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50">{savingPromo ? 'Saving...' : editingPromo ? 'Save' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PaymentTab({ hotelId, showFeedback }: { hotelId: string; showFeedback: (type: 'success' | 'error', message: string) => void }) {
  const [commissionRate, setCommissionRate] = useState(5)
  const [fixedFee, setFixedFee] = useState(30)
  const [activePlan, setActivePlan] = useState('commission')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    bookingSettingsService.listAllHotels()
      .then((hotels) => {
        const hotel = hotels.find((h) => h.id === hotelId)
        if (hotel) {
          setCommissionRate(hotel.billing_commission_rate || 5)
          setFixedFee(hotel.billing_fixed_fee || 30)
          setActivePlan(hotel.billing_active_plan || 'commission')
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [hotelId])

  const handleSave = async () => {
    setSaving(true)
    try {
      await bookingSettingsService.updateHotelBilling(hotelId, {
        billing_commission_rate: commissionRate,
        billing_fixed_fee: fixedFee,
      })
      showFeedback('success', 'Billing settings saved')
    } catch {
      showFeedback('error', 'Failed to save billing settings')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="max-w-2xl"><div className="animate-pulse h-48 bg-gray-200 rounded-lg" /></div>

  return (
    <div className="max-w-2xl space-y-4">
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h2 className="text-[14px] font-semibold text-gray-900">Current Plan</h2>
        <p className="text-[12px] text-gray-500 mt-0.5 mb-3">This hotel is on the <strong>{activePlan === 'fixed' ? 'Fixed Fee' : 'Commission'}</strong> plan.</p>
        <span className={`inline-flex px-2.5 py-1 rounded-full text-[11px] font-bold ${activePlan === 'fixed' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
          {activePlan === 'fixed' ? 'Fixed Fee' : 'Commission'}
        </span>
      </div>
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h2 className="text-[14px] font-semibold text-gray-900">Commission Rate</h2>
        <p className="text-[12px] text-gray-500 mt-0.5 mb-3">Percentage charged on each booking.</p>
        <div className="flex items-center gap-2">
          <input type="number" min={0} max={100} step={0.5} value={commissionRate} onChange={(e) => setCommissionRate(Number(e.target.value))} className="w-24 px-3 py-2 border border-gray-300 rounded-lg text-[14px] font-semibold text-center focus:outline-none focus:ring-2 focus:ring-primary-500" />
          <span className="text-[14px] font-medium text-gray-600">% per booking</span>
        </div>
      </div>
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h2 className="text-[14px] font-semibold text-gray-900">Fixed Monthly Fee</h2>
        <p className="text-[12px] text-gray-500 mt-0.5 mb-3">Monthly subscription fee. Base $30 + $5 per additional room.</p>
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-medium text-gray-600">$</span>
          <input type="number" min={0} step={5} value={fixedFee} onChange={(e) => setFixedFee(Number(e.target.value))} className="w-24 px-3 py-2 border border-gray-300 rounded-lg text-[14px] font-semibold text-center focus:outline-none focus:ring-2 focus:ring-primary-500" />
          <span className="text-[14px] font-medium text-gray-600">per month</span>
        </div>
      </div>
      <div className="flex justify-end">
        <button onClick={handleSave} disabled={saving} className="px-5 py-2 text-[13px] font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors">
          {saving ? 'Saving...' : 'Save Billing Settings'}
        </button>
      </div>
    </div>
  )
}
