/**
 * Shown when a request hits the storefront on a hostname that doesn't
 * map to any hotel (custom domain without a `booking_hotels.custom_domain`
 * record yet, unknown subdomain, etc).
 *
 * VAY-394: this replaces the previous fallback that loaded the
 * `hotel-alpenrose` dev slug in production and surfaced "Hotel
 * 'hotel-alpenrose' not found" to guests.
 */
export default function DomainNotConfigured({ hostname }: { hostname?: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8 max-w-md w-full text-center">
        <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </div>
        <h1 className="text-lg font-bold text-gray-900 mb-2">Domain not configured</h1>
        <p className="text-sm text-gray-600">
          {hostname ? (
            <>
              <span className="font-mono">{hostname}</span> isn&apos;t connected to a property
              on Vayada yet.
            </>
          ) : (
            <>This domain isn&apos;t connected to a property on Vayada yet.</>
          )}
        </p>
        <p className="text-sm text-gray-600 mt-3">
          If you&apos;re the property owner, finish the Custom Domain step in your
          Booking Engine admin. Otherwise, please check the URL or contact the
          property directly.
        </p>
      </div>
    </div>
  )
}
