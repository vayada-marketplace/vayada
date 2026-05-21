import SWRProvider from '@/components/SWRProvider'

/**
 * Authentication is gated server-side by middleware.ts (cookie
 * presence check) plus the API client (401 handling on data fetches).
 * This layout no longer needs a client-side check or the loading flash
 * that came with it.
 */
export default function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <SWRProvider>{children}</SWRProvider>
}
