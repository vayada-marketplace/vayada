'use client'

import { useState, useEffect, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import BookingNavigation from '@/components/layout/BookingNavigation'
import BookingFooter from '@/components/layout/BookingFooter'
import Image from 'next/image'
import { useHotel, useSlug } from '@/contexts/HotelContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { Booking } from '@/lib/types'
import { bookingService } from '@/services/api/booking'

function CountdownTimer({ deadline }: { deadline: string }) {
  const [timeLeft, setTimeLeft] = useState('')

  useEffect(() => {
    const update = () => {
      const now = new Date().getTime()
      const end = new Date(deadline).getTime()
      const diff = end - now

      if (diff <= 0) {
        setTimeLeft('Expired')
        return
      }

      const hours = Math.floor(diff / (1000 * 60 * 60))
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
      const seconds = Math.floor((diff % (1000 * 60)) / 1000)
      setTimeLeft(`${hours}h ${minutes}m ${seconds}s`)
    }

    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [deadline])

  return <span className="font-mono text-lg font-bold text-amber-600">{timeLeft}</span>
}

export default function BookingConfirmationPage({
  params,
}: {
  params: { reference: string }
}) {
  const t = useTranslations('confirmation')
  const tc = useTranslations('common')
  const { hotel } = useHotel()
  const { slug } = useSlug()
  const { formatPrice } = useCurrency()
  const [booking, setBooking] = useState<Booking | null>(null)
  const [status, setStatus] = useState<string>('pending')
  const [withdrawing, setWithdrawing] = useState(false)
  const [withdrawError, setWithdrawError] = useState('')

  useEffect(() => {
    const stored = sessionStorage.getItem('lastBooking')
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        if (parsed.bookingReference === params.reference) {
          setBooking(parsed)
          setStatus(parsed.status || 'pending')
        }
      } catch {
        // ignore
      }
    }
  }, [params.reference])

  // Poll for status updates every 30s when pending
  useEffect(() => {
    if (status !== 'pending' || !booking?.guestEmail) return

    const poll = async () => {
      try {
        const result = await bookingService.getStatus(slug, params.reference, booking.guestEmail)
        if (result.status !== status) {
          setStatus(result.status)
          // Update stored booking
          if (booking) {
            const updated = { ...booking, status: result.status }
            setBooking(updated)
            sessionStorage.setItem('lastBooking', JSON.stringify(updated))
          }
        }
      } catch {
        // Ignore polling errors
      }
    }

    const interval = setInterval(poll, 30000)
    return () => clearInterval(interval)
  }, [status, booking, slug, params.reference])

  const handleWithdraw = async () => {
    if (!booking) return
    setWithdrawing(true)
    setWithdrawError('')

    try {
      await bookingService.withdraw(slug, booking.id, booking.guestEmail)
      setStatus('cancelled')
      const updated = { ...booking, status: 'cancelled' as const }
      setBooking(updated)
      sessionStorage.setItem('lastBooking', JSON.stringify(updated))
    } catch (err: any) {
      setWithdrawError(err.message || 'Failed to withdraw booking')
    } finally {
      setWithdrawing(false)
    }
  }

  const isPending = status === 'pending'
  const isConfirmed = status === 'confirmed'
  const isCancelled = status === 'cancelled'
  const isExpired = status === 'expired'

  return (
    <div className="min-h-screen bg-surface">
      {/* Mini Hero */}
      <div className="relative h-32 w-full">
        <Image
          src={hotel.heroImage}
          alt={hotel.name}
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 to-black/60" />
        <BookingNavigation />
      </div>

      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center">
          {/* Status Icon */}
          {isPending && (
            <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg className="w-8 h-8 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          )}
          {isConfirmed && (
            <div className="w-16 h-16 bg-success-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg className="w-8 h-8 text-success-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
          )}
          {(isCancelled || isExpired) && (
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
          )}

          {/* Status Title */}
          {isPending && (
            <>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">
                {t('requestSubmitted') || 'Booking Request Submitted'}
              </h1>
              <p className="text-gray-600 mb-4">
                {t('pendingSubtitle') || 'Your booking request has been submitted. The host will respond within 24 hours.'}
              </p>
              {booking?.hostResponseDeadline && (
                <div className="mb-6">
                  <p className="text-sm text-gray-500 mb-1">{t('hostResponseIn') || 'Host will respond in:'}</p>
                  <CountdownTimer deadline={booking.hostResponseDeadline} />
                </div>
              )}
            </>
          )}
          {isConfirmed && (
            <>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">{t('title')}</h1>
              <p className="text-gray-600 mb-6">{t('subtitle')}</p>
            </>
          )}
          {isCancelled && (
            <>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">
                {t('cancelledTitle') || 'Booking Cancelled'}
              </h1>
              <p className="text-gray-600 mb-6">
                {booking?.paymentMethod === 'card'
                  ? (t('cancelledCardSubtitle') || 'Your booking has been cancelled. Any authorization hold on your card has been released.')
                  : (t('cancelledSubtitle') || 'Your booking has been cancelled.')
                }
              </p>
            </>
          )}
          {isExpired && (
            <>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">
                {t('expiredTitle') || 'Booking Request Expired'}
              </h1>
              <p className="text-gray-600 mb-6">
                {t('expiredSubtitle') || 'Your booking request expired because the host did not respond within 24 hours. Any card hold has been released.'}
              </p>
            </>
          )}

          {/* Booking Reference */}
          <div className="bg-gray-50 rounded-xl p-4 mb-8 inline-block">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">{t('bookingReference')}</p>
            <p className="text-2xl font-bold text-primary-600 tracking-wider">{params.reference}</p>
          </div>

          {/* Booking Details */}
          <div className="text-left space-y-0 divide-y divide-gray-100">
            <div className="flex justify-between py-3">
              <span className="text-gray-600">{t('hotel')}</span>
              <span className="font-medium text-gray-900">{booking?.hotelName || hotel.name}</span>
            </div>
            <div className="flex justify-between py-3">
              <span className="text-gray-600">{t('room')}</span>
              <span className="font-medium text-gray-900">{booking?.roomName || '—'}</span>
            </div>
            <div className="flex justify-between py-3">
              <span className="text-gray-600">{t('checkIn')}</span>
              <span className="font-medium text-gray-900">{booking?.checkIn || '—'}</span>
            </div>
            <div className="flex justify-between py-3">
              <span className="text-gray-600">{t('checkOut')}</span>
              <span className="font-medium text-gray-900">{booking?.checkOut || '—'}</span>
            </div>
            <div className="flex justify-between py-3">
              <span className="text-gray-600">{t('duration')}</span>
              <span className="font-medium text-gray-900">
                {booking ? tc('nights', { count: booking.nights }) : '—'}
              </span>
            </div>
            <div className="flex justify-between py-3">
              <span className="text-gray-600">{t('guests')}</span>
              <span className="font-medium text-gray-900">
                {booking ? `${booking.adults} ${booking.adults === 1 ? 'Adult' : 'Adults'}${booking.children > 0 ? `, ${booking.children} ${booking.children === 1 ? 'Child' : 'Children'}` : ''}` : '—'}
              </span>
            </div>
            <div className="flex justify-between py-3">
              <span className="text-gray-600">{t('totalPaid')}</span>
              <span className="font-bold text-gray-900 text-lg">
                {booking ? formatPrice(booking.totalAmount, booking.currency) : '—'}
              </span>
            </div>
            {booking?.paymentMethod && (
              <div className="flex justify-between py-3">
                <span className="text-gray-600">{t('paymentMethodLabel') || 'Payment'}</span>
                <span className="font-medium text-gray-900">
                  {booking.paymentMethod === 'card' ? 'Card' : 'Pay at Property'}
                </span>
              </div>
            )}
          </div>

          {/* Withdraw button for pending bookings */}
          {isPending && (
            <div className="mt-8">
              {withdrawError && (
                <p className="text-sm text-red-600 mb-3">{withdrawError}</p>
              )}
              <button
                onClick={handleWithdraw}
                disabled={withdrawing}
                className="px-6 py-3 border border-red-300 text-red-600 font-semibold rounded-full hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                {withdrawing ? (t('withdrawing') || 'Withdrawing...') : (t('withdrawRequest') || 'Withdraw Request')}
              </button>
            </div>
          )}

          {/* Actions */}
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/"
              className="px-6 py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors"
            >
              {t('backToHotel')}
            </Link>
            <Link
              href="/my-booking"
              className="px-6 py-3 border border-gray-300 text-gray-700 font-semibold rounded-full hover:bg-gray-50 transition-colors"
            >
              {t('manageBooking')}
            </Link>
          </div>
        </div>

        {/* Email notice */}
        <p className="text-center text-sm text-gray-500 mt-6">
          {t('emailNotice')}
        </p>
      </div>

      <BookingFooter />
    </div>
  )
}
