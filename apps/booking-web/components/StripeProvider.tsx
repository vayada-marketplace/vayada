'use client'

import { Elements } from '@stripe/react-stripe-js'
import stripePromise from '@/lib/stripe'

interface StripeProviderProps {
  clientSecret: string
  children: React.ReactNode
}

export default function StripeProvider({ clientSecret, children }: StripeProviderProps) {
  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret,
        appearance: {
          theme: 'stripe',
          variables: {
            colorPrimary: '#1a1a2e',
            borderRadius: '8px',
          },
        },
      }}
    >
      {children}
    </Elements>
  )
}
