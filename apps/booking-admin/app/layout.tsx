import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Vayada Booking Engine - Admin',
  description: 'Hotel admin dashboard for Vayada Booking Engine',
  icons: {
    icon: [{ url: '/vayada-logo.png' }],
    apple: [{ url: '/vayada-logo.png' }],
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        {children}
      </body>
    </html>
  )
}
