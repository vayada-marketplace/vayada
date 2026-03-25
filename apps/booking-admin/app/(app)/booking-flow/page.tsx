'use client'

import { useState, useEffect, useRef } from 'react'
import {
  XMarkIcon,
  PhotoIcon,
} from '@heroicons/react/24/outline'
import { settingsService, type AddonItem, type AddonSettings, type DesignSettings, type PropertySettings } from '@/services/settings'
import { pmsClient } from '@/services/api/pmsClient'
import { ToggleSwitch, FeedbackAlert } from '@/components/ui'
import { uploadSingleImage } from '@/lib/utils/uploadImage'

import RoomsTab from '@/components/booking-flow/RoomsTab'
import AddonsTab from '@/components/booking-flow/AddonsTab'
import DetailsTab from '@/components/booking-flow/DetailsTab'
import PaymentTab from '@/components/booking-flow/PaymentTab'
import BenefitsTab from '@/components/booking-flow/BenefitsTab'

type Tab = 'rooms' | 'addons' | 'details' | 'payment' | 'benefits'

const CATEGORIES = [
  { value: 'transport', label: 'Transport' },
  { value: 'wellness', label: 'Wellness' },
  { value: 'dining', label: 'Dining' },
  { value: 'experience', label: 'Experience' },
  { value: 'other', label: 'Other' },
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
  perNight: false,
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
  const [uploadingImage, setUploadingImage] = useState(false)
  const addonFileInputRef = useRef<HTMLInputElement>(null)

  // Benefits state
  const [benefits, setBenefits] = useState<string[]>([])
  const [benefitInput, setBenefitInput] = useState('')
  const [savingBenefits, setSavingBenefits] = useState(false)

  // Rooms state (filters)
  const [bookingFilters, setBookingFilters] = useState<string[]>([])
  const [customFilters, setCustomFilters] = useState<Record<string, string>>({})
  const [filterRooms, setFilterRooms] = useState<Record<string, string[]>>({})
  const [filtersEnabled, setFiltersEnabled] = useState(false)
  const [savingFilters, setSavingFilters] = useState(false)
  const [pmsRooms, setPmsRooms] = useState<{ id: string; name: string }[]>([])
  const [pmsRoomsLoading, setPmsRoomsLoading] = useState(false)

  useEffect(() => {
    Promise.all([
      settingsService.listAddons().catch(() => []),
      settingsService.getAddonSettings().catch(() => ({ showAddonsStep: true, groupAddonsByCategory: true })),
      settingsService.getDesignSettings().catch(() => ({ hero_image: '', hero_heading: '', hero_subtext: '', primary_color: '', accent_color: '', font_pairing: '', booking_filters: [], custom_filters: {}, filter_rooms: {} } as DesignSettings)),
      settingsService.getBenefits().catch(() => ({ benefits: [] })),
      settingsService.getPropertySettings().catch(() => null),
    ]).then(([addonList, settings, design, benefitsRes, property]) => {
      setAddons(addonList)
      setAddonSettings(settings)
      setBenefits(benefitsRes.benefits || [])
      if (design.booking_filters) {
        setBookingFilters(design.booking_filters)
        setFiltersEnabled(design.booking_filters.length > 0)
      }
      if (design.custom_filters) {
        setCustomFilters(design.custom_filters)
      }
      if (design.filter_rooms) {
        setFilterRooms(design.filter_rooms)
      }
      // Fetch rooms from PMS
      if (property?.slug) {
        setPmsRoomsLoading(true)
        pmsClient.get<{ id: string; name: string }[]>(`/api/hotels/${property.slug}/rooms`)
          .then((rooms) => setPmsRooms(rooms.map((r) => ({ id: r.id, name: r.name }))))
          .catch(() => setPmsRooms([]))
          .finally(() => setPmsRoomsLoading(false))
      }
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
      perNight: addon.perNight || false,
    })
    setShowModal(true)
  }

  const handleAddonImageUpload = async (file: File) => {
    const previousImage = formData.image
    const previewUrl = URL.createObjectURL(file)
    setFormData((prev) => ({ ...prev, image: previewUrl }))

    try {
      setUploadingImage(true)
      const s3Url = await uploadSingleImage(file)
      URL.revokeObjectURL(previewUrl)
      setFormData((prev) => ({ ...prev, image: s3Url }))
    } catch (err) {
      console.error('Image upload failed:', err)
      URL.revokeObjectURL(previewUrl)
      setFormData((prev) => ({ ...prev, image: previousImage }))
      showFeedback('error', 'Image upload failed. Please try again.')
    } finally {
      setUploadingImage(false)
    }
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
        image: formData.image.startsWith('blob:') ? '' : formData.image,
        duration: formData.duration || undefined,
        perPerson: formData.perPerson,
        perNight: formData.perNight,
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

  const handleToggleFiltersEnabled = async () => {
    const newEnabled = !filtersEnabled
    setFiltersEnabled(newEnabled)
    if (!newEnabled) {
      // Auto-save when disabling filters
      try {
        await settingsService.updateDesignSettings({ booking_filters: [], custom_filters: customFilters, filter_rooms: {} })
      } catch {
        setFiltersEnabled(true)
        setFeedback({ type: 'error', message: 'Failed to disable filters' })
      }
    }
  }

  const handleSaveFilters = async () => {
    try {
      setSavingFilters(true)
      const filters = filtersEnabled ? bookingFilters : []
      const rooms = filtersEnabled ? filterRooms : {}
      await settingsService.updateDesignSettings({ booking_filters: filters, custom_filters: customFilters, filter_rooms: rooms })
      showFeedback('success', 'Filters saved successfully')
    } catch {
      showFeedback('error', 'Failed to save filters')
    } finally {
      setSavingFilters(false)
    }
  }

  // ── Benefits handlers ──

  const handleSaveBenefits = async () => {
    try {
      setSavingBenefits(true)
      await settingsService.updateBenefits(benefits)
      showFeedback('success', 'Benefits saved successfully')
    } catch {
      showFeedback('error', 'Failed to save benefits')
    } finally {
      setSavingBenefits(false)
    }
  }

  const tabs = [
    { id: 'rooms' as const, label: 'Rooms', icon: RoomsIcon },
    { id: 'addons' as const, label: 'Add-ons', icon: AddonsIcon },
    { id: 'benefits' as const, label: 'Benefits', icon: BenefitsIcon },
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
        <FeedbackAlert type={feedback.type} message={feedback.message} className="mt-3 shrink-0" />
      )}

      {/* Tab bar */}
      <div className="mt-5 bg-gray-100 rounded-lg p-1 grid grid-cols-5 shrink-0 max-w-xl">
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
        {activeTab === 'rooms' && (
          <RoomsTab
            bookingFilters={bookingFilters}
            setBookingFilters={setBookingFilters}
            customFilters={customFilters}
            setCustomFilters={setCustomFilters}
            filterRooms={filterRooms}
            setFilterRooms={setFilterRooms}
            filtersEnabled={filtersEnabled}
            onToggleFiltersEnabled={handleToggleFiltersEnabled}
            handleSaveFilters={handleSaveFilters}
            savingFilters={savingFilters}
            rooms={pmsRooms}
            roomsLoading={pmsRoomsLoading}
          />
        )}

        {activeTab === 'addons' && (
          <AddonsTab
            addons={addons}
            addonSettings={addonSettings}
            deletingId={deletingId}
            openCreateModal={openCreateModal}
            openEditModal={openEditModal}
            handleDeleteAddon={handleDeleteAddon}
            handleToggleAddonSetting={handleToggleAddonSetting}
          />
        )}

        {activeTab === 'benefits' && (
          <BenefitsTab
            benefits={benefits}
            setBenefits={setBenefits}
            benefitInput={benefitInput}
            setBenefitInput={setBenefitInput}
            saveBenefits={handleSaveBenefits}
            savingBenefits={savingBenefits}
          />
        )}

        {activeTab === 'details' && <DetailsTab />}

        {activeTab === 'payment' && <PaymentTab />}
      </div>

      {/* ADD/EDIT ADDON MODAL */}
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
                    value={formData.price || ''}
                    onChange={(e) => setFormData({ ...formData, price: parseFloat(e.target.value) || 0 })}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
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
                    <option value="IDR">IDR</option>
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

              {/* Image */}
              <div>
                <label className="block text-[12px] font-medium text-gray-700 mb-0.5">Image</label>
                {formData.image ? (
                  <div className="relative rounded-lg overflow-hidden bg-gray-200">
                    <img
                      src={formData.image}
                      alt="Add-on"
                      className="w-full h-36 object-cover"
                      onError={(e) => { e.currentTarget.style.display = 'none' }}
                    />
                    <button
                      type="button"
                      onClick={() => setFormData({ ...formData, image: '' })}
                      className="absolute top-1.5 right-1.5 w-6 h-6 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center transition-colors"
                    >
                      <XMarkIcon className="w-3.5 h-3.5" />
                    </button>
                    {uploadingImage && (
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => addonFileInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
                    onDrop={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      const file = e.dataTransfer.files?.[0]
                      if (file && file.type.startsWith('image/')) handleAddonImageUpload(file)
                    }}
                    className="w-full h-36 border-2 border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center gap-1.5 text-gray-400 hover:border-gray-400 hover:text-gray-500 transition-colors"
                  >
                    {uploadingImage ? (
                      <div className="w-5 h-5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <>
                        <PhotoIcon className="w-6 h-6" />
                        <span className="text-[12px]">Click or drag to upload</span>
                      </>
                    )}
                  </button>
                )}
                <input
                  ref={addonFileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) handleAddonImageUpload(file)
                    e.target.value = ''
                  }}
                  className="hidden"
                />
                {formData.image && !uploadingImage && (
                  <button
                    type="button"
                    onClick={() => addonFileInputRef.current?.click()}
                    className="mt-2 w-full py-1.5 text-[12px] text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Replace Image
                  </button>
                )}
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
              <ToggleSwitch
                size="sm"
                enabled={formData.perPerson}
                onChange={() => setFormData({ ...formData, perPerson: !formData.perPerson })}
                label="Per Person Pricing"
                description="Price is multiplied by number of guests"
              />

              {/* Per Night toggle */}
              <ToggleSwitch
                size="sm"
                enabled={formData.perNight}
                onChange={() => setFormData({ ...formData, perNight: !formData.perNight })}
                label="Per Night Pricing"
                description="Price is charged for each night of the stay (e.g. daily breakfast)"
              />
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

/* Tab Icon Components */

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

function BenefitsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 12l2 2 4-4" />
      <path d="M12 3a9 9 0 100 18 9 9 0 000-18z" />
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
