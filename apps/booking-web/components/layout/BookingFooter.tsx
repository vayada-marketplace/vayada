'use client'

import { useHotel } from '@/contexts/HotelContext'
import { useTranslations } from 'next-intl'

export default function BookingFooter() {
  const { hotel } = useHotel()
  const t = useTranslations('common')

  return (
    <footer className="bg-primary-600 text-white py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          {/* Hotel Info */}
          <div>
            <h3 className="text-lg font-bold mb-2">{hotel.name}</h3>
            <p className="text-white/80 text-sm leading-relaxed">
              {hotel.description}
            </p>
          </div>

          {/* Contact */}
          <div>
            <h4 className="text-sm font-bold uppercase tracking-wider mb-3">{t('contact')}</h4>
            <div className="space-y-1 text-sm text-white/80">
              <p>{hotel.contact.address}</p>
              <p>{t('phone')}: {hotel.contact.phone}</p>
              <p>{t('email')}: {hotel.contact.email}</p>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="border-t border-white/20 pt-4">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-1 text-xs text-white/70">
            <p>&copy; {new Date().getFullYear()} {t('allRightsReserved', { name: hotel.name })}</p>
            <p>
              {t('poweredBy')}{' '}
              <span className="text-white font-semibold underline">vayada</span>
            </p>
          </div>
        </div>
      </div>
    </footer>
  )
}
