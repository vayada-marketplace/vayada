import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Hotel Alpenrose — Book Your Stay',
  description:
    'A boutique alpine retreat featuring panoramic mountain views, world-class spa facilities, and refined Austrian hospitality in the heart of Innsbruck.',
  icons: {
    icon: [{ url: '/vayada-logo.png' }],
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>{children}</body>
    </html>
  )
}
