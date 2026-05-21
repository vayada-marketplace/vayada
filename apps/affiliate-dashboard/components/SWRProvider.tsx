'use client'

import type { ReactNode } from 'react'
import { SWRConfig } from 'swr'
import { fetcher } from '@/services/api/fetcher'

export default function SWRProvider({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        fetcher,
        revalidateOnFocus: false,
        shouldRetryOnError: false,
      }}
    >
      {children}
    </SWRConfig>
  )
}
