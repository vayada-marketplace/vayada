'use client'

import { useState, useEffect } from 'react'
import {
  PlusIcon,
  PencilSquareIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline'
import { settingsService, type AddonItem, type AddonSettings, type DesignSettings } from '@/services/settings'

type Tab = 'rooms' | 'addons' | 'details' | 'payment'

const CATEGORIES = [
  { value: 'transport', label: 'Transport' },
  { value: 'wellness', label: 'Wellness' },
  { value: 'dining', label: 'Dining' },
  { value: 'experience', label: 'Experience' },
]

const CATEGORY_COLORS: Record<string, string> = {
  transport: 'bg-blue-100 text-blue-700',
  wellness: 'bg-purple-100 text-purple-700',
  dining: 'bg-orange-100 text-orange-700',
  experience: 'bg-green-100 text-green-700',
}

const GUEST_INFO_FIELDS = [
  { name: 'First Name', type: 'Text', required: true },
  { name: 'Last Name', type: 'Text', required: true },
  { name: 'Email', type: 'Email', required: true },
  { name: 'Phone Number', type: 'Phone', required: true },
  { name: 'Country', type: 'Select', required: true },
  { name: 'Arrival Time', type: 'Time', required: false },
  { name: 'Special Requests', type: 'Textarea', required: false },
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

export default function BookingFlowPage() {
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

  // Rooms state (read-only, from design settings for filters)
  const [bookingFilters, setBookingFilters] = useState<string[]>([])
  const [savingFilters, setSavingFilters] = useState(false)

  const AVAILABLE_FILTERS = [
    { key: 'includeBreakfast', label: 'Include Breakfast' },
    { key: 'freeCancellation', label: 'Free Cancellation' },
    { key: 'payAtHotel', label: 'Pay at Hotel' },
    { key: 'bestRated', label: 'Best Rated' },
    { key: 'mountainView', label: 'Mountain View' },
  ]

  useEffect(() => {
    Promise.all([
      settingsService.listAddons().catch(() => []),
      settingsService.getAddonSettings().catch(() => ({ showAddonsStep: true, groupAddonsByCategory: true })),
      settingsService.getDesignSettings().catch(() => ({ hero_image: '', hero_heading: '', hero_subtext: '', primary_color: '', accent_color: '', font_pairing: '', booking_filters: [], custom_filters: {} } as DesignSettings)),
    ]).then(([addonList, settings, design]) => {
      setAddons(addonList)
      setAddonSettings(settings)
      if (design.booking_filters) setBookingFilters(design.booking_filters)
    }).finally(() => setLoading(false))
  }, [])

  const showFeedback = (type: 'success' | 'error', message: string) => {
    setFeedback({ type, message })
    setTimeout(() => setFeedback(null), 3000)
  }

  // ── Add-on CRUD handlers ──

  const openCreateModal = () => {
    setEditingAddon(null)
    setFormData({ ...emptyAddon })
    setShowModal(true)
  }

  const openEditModal = (addon: AddonItem) => {
    setEditingAddon(addon)
    setFormData({
      name: addon.name,
      description: addon.description,
      price: addon.price,
      currency: addon.currency,
      category: addon.category,
      image: addon.image,
      duration: addon.duration || '',
      perPerson: addon.perPerson || false,
    })
    setShowModal(true)
  }

  const handleSaveAddon = async () => {
    if (!formData.name.trim()) return
    try {
      setSavingAddon(true)
      const payload = {
        name: formData.name,
        description: formData.description,
        price: formData.price,
        currency: formData.currency,
        category: formData.category,
        image: formData.image,
        duration: formData.duration || undefined,
        perPerson: formData.perPerson,
      }
      if (editingAddon) {
        const updated = await settingsService.updateAddon(editingAddon.id, payload)
        setAddons((prev) => prev.map((a) => (a.id === editingAddon.id ? updated : a)))
        showFeedback('success', 'Add-on updated successfully')
      } else {
        const created = await settingsService.createAddon(payload as Omit<AddonItem, 'id'>)
        setAddons((prev) => [...prev, created])
        showFeedback('success', 'Add-on created successfully')
      }
      setShowModal(false)
    } catch {
      showFeedback('error', 'Failed to save add-on')
    } finally {
      setSavingAddon(false)
    }
  }

  const handleDeleteAddon = async (id: string) => {
    if (!confirm('Are you sure you want to delete this add-on?')) return
    try {
      setDeletingId(id)
      await settingsService.deleteAddon(id)
      setAddons((prev) => prev.filter((a) => a.id !== id))
      showFeedback('success', 'Add-on deleted')
    } catch {
      showFeedback('error', 'Failed to delete add-on')
    } finally {
      setDeletingId(null)
    }
  }

  const handleToggleAddonSetting = async (key: keyof AddonSettings) => {
    const newValue = !addonSettings[key]
    const updated = { ...addonSettings, [key]: newValue }
    setAddonSettings(updated)
    try {
      await settingsService.updateAddonSettings({ [key]: newValue })
    } catch {
      setAddonSettings(addonSettings)
      showFeedback('error', 'Failed to update setting')
    }
  }

  // ── Filter handlers (Rooms tab) ──

  const handleToggleFilter = (key: string) => {
    setBookingFilters((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    )
  }

  const handleSaveFilters = async () => {
    try {
      setSavingFilters(true)
      await settingsService.updateDesignSettings({ booking_filters: bookingFilters })
      showFeedback('success', 'Filters saved successfully')
    } catch {
      showFeedback('error', 'Failed to save filters')
    } finally {
      setSavingFilters(false)
    }
  }

  const tabs = [
    { id: 'rooms' as const, label: 'Rooms', icon: RoomsIcon },
    { id: 'addons' as const, label: 'Add-ons', icon: AddonsIcon },
    { id: 'details' as const, label: 'Details', icon: DetailsIcon },
    { id: 'payment' as const, label: 'Payment', icon: PaymentIcon },
  ]

  if (loading) {
    return (
      <div className="p-6 h-full flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="shrink-0">
        <h1 className="text-xl font-bold text-gray-900">Booking Flow</h1>
        <p className="text-sm text-gray-500 mt-0.5">Configure each step of your guest&apos;s booking experience</p>
      </div>

      {/* Feedback banner */}
      {feedback && (
        <div
          className={`mt-3 px-3 py-2.5 rounded-lg text-[13px] shrink-0 ${
            feedback.type === 'success'
              ? 'bg-green-50 text-green-800 border border-green-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}
        >
          {feedback.message}
        </div>
      )}

      {/* Tab bar */}
      <div className="mt-5 bg-gray-100 rounded-lg p-1 grid grid-cols-4 shrink-0 max-w-lg">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center justify-center gap-1 py-1.5 rounded-md text-[12px] transition-all ${
              activeTab === tab.id
                ? 'bg-white text-gray-900 font-semibold shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="mt-4 flex-1 overflow-y-auto pb-4">

        {/* ═══ ROOMS TAB ═══ */}
        {activeTab === 'rooms' && (
          <div className="max-w-2xl space-y-4">
            {/* Room Visual Merchandising */}
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <h2 className="text-[14px] font-semibold text-gray-900">Room Visual Merchandising</h2>
              <p className="text-[12px] text-gray-500 mt-0.5 mb-4">Rooms are synced from your PMS. Manage room types, images, and pricing in the Property Manager.</p>

              <div className="bg-gray-50 rounded-lg border border-gray-200 p-4 text-center">
                <div className="w-10 h-10 bg-gray-200 rounded-full mx-auto flex items-center justify-center mb-2">
                  <RoomsIcon className="w-5 h-5 text-gray-400" />
                </div>
                <p className="text-[13px] font-medium text-gray-600">Rooms are managed in your PMS</p>
                <p className="text-[12px] text-gray-400 mt-0.5">Room types, images, and pricing sync automatically</p>
              </div>
            </div>

            {/* Popular Filters */}
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <h2 className="text-[14px] font-semibold text-gray-900">Popular Filters</h2>
              <p className="text-[12px] text-gray-500 mt-0.5 mb-4">Choose which filters guests can use to narrow room results</p>

              <div className="grid grid-cols-2 gap-2">
                {AVAILABLE_FILTERS.map((filter) => {
                  const enabled = bookingFilters.includes(filter.key)
                  return (
                    <button
                      key={filter.key}
                      onClick={() => handleToggleFilter(filter.key)}
                      className={`flex items-center justify-between p-3 rounded-lg border transition-all text-left ${
                        enabled
                          ? 'border-primary-500 bg-primary-50/30'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <span className="text-[12px] font-medium text-gray-900">{filter.label}</span>
                      <div className={`w-8 h-5 rounded-full transition-colors relative ${enabled ? 'bg-primary-500' : 'bg-gray-300'}`}>
                        <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${enabled ? 'left-3.5' : 'left-0.5'}`} />
                      </div>
                    </button>
                  )
                })}
              </div>

              <button
                onClick={handleSaveFilters}
                disabled={savingFilters}
                className="mt-4 inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-primary-500 text-white text-[13px] font-medium rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors"
              >
                {savingFilters ? (
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : null}
                Save Filters
              </button>
            </div>
          </div>
        )}

        {/* ═══ ADD-ONS TAB ═══ */}
        {activeTab === 'addons' && (
          <div className="max-w-2xl space-y-4">
            {/* Guest Experiences */}
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-[14px] font-semibold text-gray-900">Guest Experiences</h2>
                  <p className="text-[12px] text-gray-500 mt-0.5">Upsells and add-ons shown during the booking flow</p>
                </div>
                <button
                  onClick={openCreateModal}
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary-500 text-white text-[12px] font-medium rounded-lg hover:bg-primary-600 transition-colors"
                >
                  <PlusIcon className="w-3.5 h-3.5" />
                  Add Experience
                </button>
              </div>

              {addons.length === 0 ? (
                <div className="bg-gray-50 rounded-lg border border-dashed border-gray-300 p-6 text-center">
                  <div className="w-10 h-10 bg-gray-200 rounded-full mx-auto flex items-center justify-center mb-2">
                    <AddonsIcon className="w-5 h-5 text-gray-400" />
                  </div>
                  <p className="text-[13px] font-medium text-gray-600">No add-ons yet</p>
                  <p className="text-[12px] text-gray-400 mt-0.5">Create your first guest experience to show during booking</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {addons.map((addon) => (
                    <div
                      key={addon.id}
                      className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors"
                    >
                      {/* Drag handle icon */}
                      <div className="text-gray-300 shrink-0">
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
                          <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
                          <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
                        </svg>
                      </div>

                      {/* Image thumbnail */}
                      {addon.image ? (
                        <img src={addon.image} alt={addon.name} className="w-10 h-10 rounded-md object-cover shrink-0" />
                      ) : (
                        <div className="w-10 h-10 rounded-md bg-gray-100 flex items-center justify-center shrink-0">
                          <AddonsIcon className="w-4 h-4 text-gray-400" />
                        </div>
                      )}

                      {/* Name and category */}
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-gray-900 truncate">{addon.name}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${CATEGORY_COLORS[addon.category] || 'bg-gray-100 text-gray-600'}`}>
                            {addon.category.charAt(0).toUpperCase() + addon.category.slice(1)}
                          </span>
                          {addon.duration && (
                            <span className="text-[11px] text-gray-400">{addon.duration}</span>
                          )}
                        </div>
                      </div>

                      {/* Price */}
                      <div className="text-right shrink-0">
                        <p className="text-[13px] font-semibold text-gray-900">
                          {addon.currency === 'EUR' ? '\u20AC' : addon.currency === 'USD' ? '$' : addon.currency}{addon.price.toFixed(2)}
                        </p>
                        {addon.perPerson && (
                          <p className="text-[10px] text-gray-400">per person</p>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => openEditModal(addon)}
                          className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md transition-colors"
                        >
                          <PencilSquareIcon className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteAddon(addon.id)}
                          disabled={deletingId === addon.id}
                          className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-md transition-colors disabled:opacity-50"
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Display Settings */}
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <h2 className="text-[14px] font-semibold text-gray-900">Display Settings</h2>
              <p className="text-[12px] text-gray-500 mt-0.5 mb-4">Control how add-ons appear in the booking flow</p>

              <div className="space-y-2">
                <button
                  onClick={() => handleToggleAddonSetting('showAddonsStep')}
                  className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all text-left ${
                    addonSettings.showAddonsStep
                      ? 'border-primary-500 bg-primary-50/30'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div>
                    <span className="text-[12px] font-medium text-gray-900">Show Add-ons Step</span>
                    <p className="text-[11px] text-gray-500 mt-0.5">Display the add-ons step in the booking flow</p>
                  </div>
                  <div className={`w-8 h-5 rounded-full transition-colors relative ${addonSettings.showAddonsStep ? 'bg-primary-500' : 'bg-gray-300'}`}>
                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${addonSettings.showAddonsStep ? 'left-3.5' : 'left-0.5'}`} />
                  </div>
                </button>

                <button
                  onClick={() => handleToggleAddonSetting('groupAddonsByCategory')}
                  className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all text-left ${
                    addonSettings.groupAddonsByCategory
                      ? 'border-primary-500 bg-primary-50/30'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div>
                    <span className="text-[12px] font-medium text-gray-900">Group by Category</span>
                    <p className="text-[11px] text-gray-500 mt-0.5">Organize add-ons by category (Transport, Wellness, etc.)</p>
                  </div>
                  <div className={`w-8 h-5 rounded-full transition-colors relative ${addonSettings.groupAddonsByCategory ? 'bg-primary-500' : 'bg-gray-300'}`}>
                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${addonSettings.groupAddonsByCategory ? 'left-3.5' : 'left-0.5'}`} />
                  </div>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ═══ DETAILS TAB ═══ */}
        {activeTab === 'details' && (
          <div className="max-w-2xl space-y-4">
            {/* Guest Information Fields */}
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <h2 className="text-[14px] font-semibold text-gray-900">Guest Information Fields</h2>
              <p className="text-[12px] text-gray-500 mt-0.5 mb-4">Fields collected during the booking details step</p>

              <div className="space-y-1">
                {GUEST_INFO_FIELDS.map((field) => (
                  <div
                    key={field.name}
                    className="flex items-center justify-between p-3 rounded-lg border border-gray-200"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-[13px] font-medium text-gray-900">{field.name}</span>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
                        {field.type}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      {field.required && (
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-50 text-red-600">
                          Required
                        </span>
                      )}
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-50 text-green-600">
                        Enabled
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Additional Options */}
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <h2 className="text-[14px] font-semibold text-gray-900">Additional Options</h2>
              <p className="text-[12px] text-gray-500 mt-0.5 mb-4">Optional features on the details page</p>

              <div className="space-y-2">
                {[
                  { label: 'Newsletter Signup', description: 'Show newsletter opt-in checkbox' },
                  { label: 'Terms & Conditions', description: 'Require agreement to terms before booking' },
                ].map((opt) => (
                  <div
                    key={opt.label}
                    className="flex items-center justify-between p-3 rounded-lg border border-primary-500 bg-primary-50/30"
                  >
                    <div>
                      <span className="text-[12px] font-medium text-gray-900">{opt.label}</span>
                      <p className="text-[11px] text-gray-500 mt-0.5">{opt.description}</p>
                    </div>
                    <div className="w-8 h-5 rounded-full bg-primary-500 relative">
                      <div className="absolute top-0.5 left-3.5 w-4 h-4 rounded-full bg-white shadow-sm" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ═══ PAYMENT TAB ═══ */}
        {activeTab === 'payment' && (
          <div className="max-w-2xl">
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <h2 className="text-[14px] font-semibold text-gray-900">Payment Configuration</h2>
              <p className="text-[12px] text-gray-500 mt-0.5 mb-4">Configure payment methods and processing</p>

              <div className="bg-gray-50 rounded-lg border border-gray-200 p-6 text-center">
                <div className="w-10 h-10 bg-gray-200 rounded-full mx-auto flex items-center justify-center mb-2">
                  <PaymentIcon className="w-5 h-5 text-gray-400" />
                </div>
                <p className="text-[13px] font-medium text-gray-600">Payment configuration coming soon</p>
                <p className="text-[12px] text-gray-400 mt-0.5">Stripe and other payment providers will be configurable here</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ═══ ADD/EDIT ADDON MODAL ═══ */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-[15px] font-semibold text-gray-900">
                {editingAddon ? 'Edit Add-on' : 'Create Add-on'}
              </h3>
              <button onClick={() => setShowModal(false)} className="p-1 text-gray-400 hover:text-gray-600 rounded-md">
                <XMarkIcon className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              {/* Name */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Name *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder="e.g., Airport Transfer"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows={2}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none"
                  placeholder="Brief description of this add-on"
                />
              </div>

              {/* Price + Currency */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Price *</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={formData.price}
                    onChange={(e) => setFormData({ ...formData, price: parseFloat(e.target.value) || 0 })}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Currency</label>
                  <select
                    value={formData.currency}
                    onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white"
                  >
                    <option value="EUR">EUR</option>
                    <option value="USD">USD</option>
                    <option value="GBP">GBP</option>
                    <option value="CHF">CHF</option>
                  </select>
                </div>
              </div>

              {/* Category */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Category</label>
                <select
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>

              {/* Image URL */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Image URL</label>
                <input
                  type="text"
                  value={formData.image}
                  onChange={(e) => setFormData({ ...formData, image: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder="https://..."
                />
              </div>

              {/* Duration */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Duration</label>
                <input
                  type="text"
                  value={formData.duration}
                  onChange={(e) => setFormData({ ...formData, duration: e.target.value })}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder="e.g., 60 min, 2 hours, Full day"
                />
              </div>

              {/* Per Person toggle */}
              <button
                type="button"
                onClick={() => setFormData({ ...formData, perPerson: !formData.perPerson })}
                className={`w-full flex items-center justify-between p-3 rounded-lg border transition-all text-left ${
                  formData.perPerson
                    ? 'border-primary-500 bg-primary-50/30'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div>
                  <span className="text-[12px] font-medium text-gray-900">Per Person Pricing</span>
                  <p className="text-[11px] text-gray-500 mt-0.5">Price is multiplied by number of guests</p>
                </div>
                <div className={`w-8 h-5 rounded-full transition-colors relative ${formData.perPerson ? 'bg-primary-500' : 'bg-gray-300'}`}>
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${formData.perPerson ? 'left-3.5' : 'left-0.5'}`} />
                </div>
              </button>
            </div>

            <div className="p-4 border-t border-gray-200 flex gap-2">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveAddon}
                disabled={savingAddon || !formData.name.trim()}
                className="flex-1 py-2 text-[13px] font-medium text-white bg-primary-500 rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5"
              >
                {savingAddon && (
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                )}
                {editingAddon ? 'Save Changes' : 'Create Add-on'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Tab Icon Components ── */

function RoomsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7v11a2 2 0 002 2h14a2 2 0 002-2V7" />
      <path d="M6 7V5a2 2 0 012-2h8a2 2 0 012 2v2" />
      <path d="M3 7h18" />
      <path d="M8 11h8" />
    </svg>
  )
}

function AddonsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  )
}

function DetailsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 12h6" />
      <path d="M9 16h6" />
    </svg>
  )
}

function PaymentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1" y="4" width="22" height="16" rx="2" />
      <path d="M1 10h22" />
      <path d="M6 16h4" />
    </svg>
  )
}
