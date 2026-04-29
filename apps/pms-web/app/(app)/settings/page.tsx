'use client'

import { useState, useEffect, useRef } from 'react'
import { bookingsService } from '@/services/bookings'
import { apiClient } from '@/services/api/client'
import { useTranslation } from '@/lib/i18n'

const CURRENCY_OPTIONS = [
  { code: 'AED', name: 'UAE Dirham', flag: '🇦🇪' },
  { code: 'AUD', name: 'Australian Dollar', flag: '🇦🇺' },
  { code: 'BGN', name: 'Bulgarian Lev', flag: '🇧🇬' },
  { code: 'BRL', name: 'Brazilian Real', flag: '🇧🇷' },
  { code: 'CAD', name: 'Canadian Dollar', flag: '🇨🇦' },
  { code: 'CHF', name: 'Swiss Franc', flag: '🇨🇭' },
  { code: 'CNY', name: 'Chinese Yuan', flag: '🇨🇳' },
  { code: 'CZK', name: 'Czech Koruna', flag: '🇨🇿' },
  { code: 'DKK', name: 'Danish Krone', flag: '🇩🇰' },
  { code: 'EUR', name: 'Euro', flag: '🇪🇺' },
  { code: 'GBP', name: 'British Pound', flag: '🇬🇧' },
  { code: 'HKD', name: 'Hong Kong Dollar', flag: '🇭🇰' },
  { code: 'HRK', name: 'Croatian Kuna', flag: '🇭🇷' },
  { code: 'HUF', name: 'Hungarian Forint', flag: '🇭🇺' },
  { code: 'IDR', name: 'Indonesian Rupiah', flag: '🇮🇩' },
  { code: 'INR', name: 'Indian Rupee', flag: '🇮🇳' },
  { code: 'JPY', name: 'Japanese Yen', flag: '🇯🇵' },
  { code: 'KRW', name: 'South Korean Won', flag: '🇰🇷' },
  { code: 'MXN', name: 'Mexican Peso', flag: '🇲🇽' },
  { code: 'MYR', name: 'Malaysian Ringgit', flag: '🇲🇾' },
  { code: 'NOK', name: 'Norwegian Krone', flag: '🇳🇴' },
  { code: 'NZD', name: 'New Zealand Dollar', flag: '🇳🇿' },
  { code: 'PHP', name: 'Philippine Peso', flag: '🇵🇭' },
  { code: 'PLN', name: 'Polish Zloty', flag: '🇵🇱' },
  { code: 'RON', name: 'Romanian Leu', flag: '🇷🇴' },
  { code: 'RUB', name: 'Russian Ruble', flag: '🇷🇺' },
  { code: 'SEK', name: 'Swedish Krona', flag: '🇸🇪' },
  { code: 'SGD', name: 'Singapore Dollar', flag: '🇸🇬' },
  { code: 'THB', name: 'Thai Baht', flag: '🇹🇭' },
  { code: 'TRY', name: 'Turkish Lira', flag: '🇹🇷' },
  { code: 'USD', name: 'US Dollar', flag: '🇺🇸' },
  { code: 'VND', name: 'Vietnamese Dong', flag: '🇻🇳' },
]

const CURRENCIES = CURRENCY_OPTIONS.map(c => ({ value: c.code, label: `${c.flag} ${c.name} (${c.code})` }))

const PROPERTY_TYPES = [
  { value: 'apart_hotel', label: 'Apart Hotel' },
  { value: 'apartment', label: 'Apartment' },
  { value: 'boat', label: 'Boat' },
  { value: 'camping', label: 'Camping' },
  { value: 'capsule_hotel', label: 'Capsule Hotel' },
  { value: 'chalet', label: 'Chalet' },
  { value: 'country_house', label: 'Country House' },
  { value: 'farm_stay', label: 'Farm Stay' },
  { value: 'guest_house', label: 'Guest House' },
  { value: 'holiday_home', label: 'Holiday Home' },
  { value: 'holiday_park', label: 'Holiday Park' },
  { value: 'homestay', label: 'Homestay' },
  { value: 'hostel', label: 'Hostel' },
  { value: 'hotel', label: 'Hotel' },
  { value: 'inn', label: 'Inn' },
  { value: 'lodge', label: 'Lodge' },
  { value: 'motel', label: 'Motel' },
  { value: 'resort', label: 'Resort' },
  { value: 'riad', label: 'Riad' },
  { value: 'ryokan', label: 'Ryokan' },
  { value: 'tent', label: 'Tent' },
  { value: 'villa', label: 'Villa' },
]

const TIMEZONE_OPTIONS = [
  'Pacific/Midway', 'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles',
  'America/Denver', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo',
  'Atlantic/Azores', 'Europe/London', 'Europe/Paris', 'Europe/Istanbul',
  'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka',
  'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura',
  'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Sydney', 'Pacific/Auckland',
]

function CurrencySelect({ value, onChange, t }: { value: string; onChange: (v: string) => void; t: (key: string) => string }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const filtered = CURRENCIES.filter(
    (c) => c.label.toLowerCase().includes(search.toLowerCase())
  )

  const selectedLabel = CURRENCIES.find((c) => c.value === value)?.label ?? value

  return (
    <div ref={ref} className="relative w-full sm:max-w-xs">
      <button
        type="button"
        onClick={() => { setOpen(!open); setSearch('') }}
        className="w-full px-3 py-2 text-sm text-left border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white flex items-center justify-between"
      >
        <span>{selectedLabel}</span>
        <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('settings.searchCurrency')}
            autoFocus
            className="w-full px-3 py-2 text-sm border-b border-gray-200 focus:outline-none rounded-t-lg"
          />
          <ul className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-gray-400">{t('common.noResults')}</li>
            ) : (
              filtered.map((c) => (
                <li
                  key={c.value}
                  onClick={() => { onChange(c.value); setOpen(false) }}
                  className={`px-3 py-2 text-sm cursor-pointer hover:bg-primary-50 ${c.value === value ? 'bg-primary-50 font-medium text-primary-700' : 'text-gray-700'}`}
                >
                  {c.label}
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  )
}

export default function SettingsPage() {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')

  // Currency
  const [currency, setCurrency] = useState('EUR')
  const [savingCurrency, setSavingCurrency] = useState(false)

  // Check-in / Check-out times
  const [checkInFrom, setCheckInFrom] = useState('14:00')
  const [checkInUntil, setCheckInUntil] = useState('22:00')
  const [checkOutFrom, setCheckOutFrom] = useState('07:00')
  const [checkOutUntil, setCheckOutUntil] = useState('11:00')
  const [savingTimes, setSavingTimes] = useState(false)

  // Property details
  const [propertyType, setPropertyType] = useState('guest_house')
  const [timezone, setTimezone] = useState('Asia/Makassar')
  const [country, setCountry] = useState('')
  const [state, setState] = useState('')
  const [city, setCity] = useState('')
  const [address, setAddress] = useState('')
  const [zipCode, setZipCode] = useState('')
  const [phone, setPhone] = useState('')
  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [savingProperty, setSavingProperty] = useState(false)

  // Booking engine
  const [instantBook, setInstantBook] = useState(false)
  const [savingInstantBook, setSavingInstantBook] = useState(false)

  useEffect(() => {
    bookingsService.getPaymentSettings()
      .then((res) => {
        setCurrency(res.paymentSettings.defaultCurrency || 'EUR')
      })
      .catch(console.error)
      .finally(() => setLoading(false))

    apiClient.get<{ check_in_from?: string; check_in_until?: string; check_out_from?: string; check_out_until?: string; check_in_time?: string; check_out_time?: string }>('/admin/settings/property')
      .then((s) => {
        if (s.check_in_from) setCheckInFrom(s.check_in_from)
        else if (s.check_in_time) setCheckInFrom(s.check_in_time)
        if (s.check_in_until) setCheckInUntil(s.check_in_until)
        if (s.check_out_from) setCheckOutFrom(s.check_out_from)
        if (s.check_out_until) setCheckOutUntil(s.check_out_until)
        else if (s.check_out_time) setCheckOutUntil(s.check_out_time)
      })
      .catch(() => {})

    apiClient.get<any>('/admin/hotel')
      .then((h) => {
        if (h.propertyType) setPropertyType(h.propertyType)
        if (h.timezone) setTimezone(h.timezone)
        if (h.country) setCountry(h.country)
        if (h.state) setState(h.state)
        if (h.city) setCity(h.city)
        if (h.address) setAddress(h.address)
        if (h.zipCode) setZipCode(h.zipCode)
        if (h.phone) setPhone(h.phone)
        if (h.latitude != null) setLatitude(String(h.latitude))
        if (h.longitude != null) setLongitude(String(h.longitude))
        setInstantBook(Boolean(h.instant_book))
      })
      .catch(() => {})
  }, [])

  const saveTimes = async () => {
    setSavingTimes(true)
    setError('')
    setSuccess('')
    try {
      await apiClient.patch('/admin/settings/property', {
        check_in_from: checkInFrom,
        check_in_until: checkInUntil,
        check_in_time: checkInFrom,
        check_out_from: checkOutFrom,
        check_out_until: checkOutUntil,
        check_out_time: checkOutUntil,
      })
      setSuccess(t('settings.timesSaved'))
    } catch (err: any) {
      setError(err.message || t('settings.failedToSaveTimes'))
    } finally {
      setSavingTimes(false)
    }
  }

  const savePropertyDetails = async () => {
    setSavingProperty(true)
    setError('')
    setSuccess('')
    try {
      await apiClient.patch('/admin/hotel', {
        property_type: propertyType,
        timezone,
        country,
        state,
        city,
        address,
        zip_code: zipCode,
        phone,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
      })
      setSuccess('Property details saved')
    } catch (err: any) {
      setError(err.message || 'Failed to save property details')
    } finally {
      setSavingProperty(false)
    }
  }

  const toggleInstantBook = async (next: boolean) => {
    setSavingInstantBook(true)
    setError('')
    setSuccess('')
    const previous = instantBook
    setInstantBook(next)
    try {
      await apiClient.patch('/admin/hotel', { instant_book: next })
      setSuccess(next ? 'Instant booking enabled' : 'Booking requests re-enabled')
    } catch (err: any) {
      setInstantBook(previous)
      setError(err.message || 'Failed to update booking acceptance setting')
    } finally {
      setSavingInstantBook(false)
    }
  }

  const saveCurrency = async () => {
    setSavingCurrency(true)
    setError('')
    setSuccess('')
    try {
      await bookingsService.updatePaymentSettings({ defaultCurrency: currency })
      setSuccess(t('settings.currencySaved'))
    } catch (err: any) {
      setError(err.message || t('settings.failedToSaveCurrency'))
    } finally {
      setSavingCurrency(false)
    }
  }

  if (loading) {
    return (
      <div className="p-4 md:p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl">
      <h1 className="text-2xl md:text-xl font-bold text-gray-900 mb-5 md:mb-6">{t('settings.title')}</h1>

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

      <div className="space-y-5 md:space-y-8">
        {/* Property Details */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Property Details</h2>
          <p className="text-xs text-gray-500 mb-4">Required for channel manager (OTA connections).</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[12px] font-semibold text-gray-700 mb-1">Property Type</label>
              <select
                value={propertyType}
                onChange={(e) => setPropertyType(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
              >
                {PROPERTY_TYPES.map((pt) => (
                  <option key={pt.value} value={pt.value}>{pt.label}</option>
                ))}
              </select>
              <p className="text-[10px] text-gray-400 mt-1">Affects channel manager billing. Only select &quot;Hotel&quot; for actual hotels.</p>
            </div>
            <div>
              <label className="block text-[12px] font-semibold text-gray-700 mb-1">Timezone</label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white"
              >
                {TIMEZONE_OPTIONS.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[12px] font-semibold text-gray-700 mb-1">Country (ISO code)</label>
              <input
                type="text"
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                placeholder="ID"
                maxLength={2}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-[12px] font-semibold text-gray-700 mb-1">State / Province</label>
              <input
                type="text"
                value={state}
                onChange={(e) => setState(e.target.value)}
                placeholder="Bali"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-[12px] font-semibold text-gray-700 mb-1">City</label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="Seminyak"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-[12px] font-semibold text-gray-700 mb-1">Zip Code</label>
              <input
                type="text"
                value={zipCode}
                onChange={(e) => setZipCode(e.target.value)}
                placeholder="80361"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-[12px] font-semibold text-gray-700 mb-1">Address</label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Jl. Raya Seminyak No. 123"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-[12px] font-semibold text-gray-700 mb-1">Phone</label>
              <input
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+62 812 3456 7890"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-[12px] font-semibold text-gray-700 mb-1">Latitude</label>
                <input
                  type="text"
                  value={latitude}
                  onChange={(e) => setLatitude(e.target.value)}
                  placeholder="-8.6917"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div className="flex-1">
                <label className="block text-[12px] font-semibold text-gray-700 mb-1">Longitude</label>
                <input
                  type="text"
                  value={longitude}
                  onChange={(e) => setLongitude(e.target.value)}
                  placeholder="115.1683"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            </div>
          </div>
          <button
            onClick={savePropertyDetails}
            disabled={savingProperty}
            className="mt-5 w-full sm:w-auto sm:block px-4 py-2.5 sm:py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {savingProperty ? 'Saving...' : 'Save'}
          </button>
        </div>

        {/* Booking Engine — accept mode */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">Booking Engine</h2>
          <p className="text-xs text-gray-500 mb-4">
            Choose how new bookings from your booking engine are accepted.
          </p>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900">
                Accept bookings instantly
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {instantBook
                  ? 'New bookings are confirmed immediately. Card payments are charged at booking time and the guest receives an instant confirmation.'
                  : 'New bookings arrive as requests. You have 24 hours to accept or reject — card payments are only authorized until you confirm.'}
              </p>
              <p className="text-[11px] text-gray-400 mt-2">
                Bank-transfer bookings always require manual review since no payment has been received yet.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={instantBook}
              disabled={savingInstantBook}
              onClick={() => toggleInstantBook(!instantBook)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 ${
                instantBook ? 'bg-primary-600' : 'bg-gray-300'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                  instantBook ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </div>

        {/* Currency */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">{t('settings.currency')}</h2>
          <p className="text-xs text-gray-500 mb-4">{t('settings.currencyDescription')}</p>
          <CurrencySelect value={currency} onChange={setCurrency} t={t} />
          <button
            onClick={saveCurrency}
            disabled={savingCurrency}
            className="mt-4 w-full sm:w-auto sm:block px-4 py-2.5 sm:py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {savingCurrency ? t('common.saving') : t('common.save')}
          </button>
        </div>

        {/* Check-in / Check-out */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-1">{t('settings.checkInCheckOut')}</h2>
          <p className="text-xs text-gray-500 mb-4">{t('settings.checkInCheckOutDescription')}</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 md:gap-6">
            <div>
              <label className="block text-[12px] font-semibold text-gray-700 mb-2">{t('settings.checkInPeriod')}</label>
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <label className="block text-[10px] text-gray-400 mb-0.5">{t('common.from')}</label>
                  <input
                    type="time"
                    value={checkInFrom}
                    onChange={(e) => setCheckInFrom(e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                </div>
                <span className="text-gray-400 mt-4">—</span>
                <div className="flex-1">
                  <label className="block text-[10px] text-gray-400 mb-0.5">{t('common.until')}</label>
                  <input
                    type="time"
                    value={checkInUntil}
                    onChange={(e) => setCheckInUntil(e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                </div>
              </div>
              <p className="text-[10px] text-gray-400 mt-1">{t('settings.checkInExample')}</p>
            </div>
            <div>
              <label className="block text-[12px] font-semibold text-gray-700 mb-2">{t('settings.checkOutPeriod')}</label>
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <label className="block text-[10px] text-gray-400 mb-0.5">{t('common.from')}</label>
                  <input
                    type="time"
                    value={checkOutFrom}
                    onChange={(e) => setCheckOutFrom(e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                </div>
                <span className="text-gray-400 mt-4">—</span>
                <div className="flex-1">
                  <label className="block text-[10px] text-gray-400 mb-0.5">{t('common.until')}</label>
                  <input
                    type="time"
                    value={checkOutUntil}
                    onChange={(e) => setCheckOutUntil(e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                </div>
              </div>
              <p className="text-[10px] text-gray-400 mt-1">{t('settings.checkOutExample')}</p>
            </div>
          </div>
          <button
            onClick={saveTimes}
            disabled={savingTimes}
            className="mt-5 w-full sm:w-auto sm:block px-4 py-2.5 sm:py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
          >
            {savingTimes ? t('common.saving') : t('common.save')}
          </button>
        </div>

      </div>
    </div>
  )
}
