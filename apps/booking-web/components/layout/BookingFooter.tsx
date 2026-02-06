export default function BookingFooter() {
  return (
    <footer className="bg-primary-600 text-white py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          {/* Hotel Info */}
          <div>
            <h3 className="text-lg font-bold mb-2">Hotel Alpenrose</h3>
            <p className="text-white/80 text-sm leading-relaxed">
              Experience boutique luxury accommodation with stunning alpine views in Innsbruck, Austria.
            </p>
          </div>

          {/* Contact */}
          <div>
            <h4 className="text-sm font-bold uppercase tracking-wider mb-3">Contact</h4>
            <div className="space-y-1 text-sm text-white/80">
              <p>Alpengasse 12, 6020 Innsbruck, Austria</p>
              <p>Phone: +43 512 123 456</p>
              <p>Email: hello@hotelalpenrose.com</p>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="border-t border-white/20 pt-4">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-1 text-xs text-white/70">
            <p>&copy; {new Date().getFullYear()} Hotel Alpenrose. All rights reserved.</p>
            <p>
              Powered by{' '}
              <span className="text-white font-semibold underline">vayada</span>
            </p>
          </div>
        </div>
      </div>
    </footer>
  )
}
