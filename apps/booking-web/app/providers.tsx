'use client'

import { HotelProvider } from '@/contexts/HotelContext'

export default function Providers({ children }: { children: React.ReactNode }) {
  return <HotelProvider>{children}</HotelProvider>
}
