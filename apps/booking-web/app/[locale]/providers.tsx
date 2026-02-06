'use client'

import { HotelProvider } from '@/contexts/HotelContext'

export default function Providers({
  children,
  locale,
}: {
  children: React.ReactNode
  locale: string
}) {
  return <HotelProvider locale={locale}>{children}</HotelProvider>
}
