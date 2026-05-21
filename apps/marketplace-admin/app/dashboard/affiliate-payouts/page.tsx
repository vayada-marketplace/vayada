'use client'

import { useState, useEffect, useMemo } from 'react'
import {
  affiliatePayoutsService,
  AffiliatePayoutSummary,
  AffiliatePayoutDetail,
} from '@/services/api/affiliatePayouts'

const PAYMENT_METHOD_OPTIONS = [
  { value: 'manual_bank', label: 'Bank transfer (manual)' },
  { value: 'manual_paypal', label: 'PayPal (manual)' },
  { value: 'wise', label: 'Wise' },
  { value: 'stripe', label: 'Stripe transfer' },
  { value: 'other', label: 'Other' },
]

function formatAmount(amount: number, currency: string) {
  return `${currency} ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function AffiliatePayoutsPage() {
  const [loading, setLoading] = useState(true)
  const [affiliates, setAffiliates] = useState<AffiliatePayoutSummary[]>([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'outstanding' | 'all'>('outstanding')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => { fetchList() }, [])

  const fetchList = () => {
    setLoading(true)
    affiliatePayoutsService.list()
      .then((res) => setAffiliates(res.affiliates))
      .catch(() => setAffiliates([]))
      .finally(() => setLoading(false))
  }

  const filtered = useMemo(() => {
    let list = affiliates
    if (filter === 'outstanding') list = list.filter((a) => a.outstandingAmount > 0)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        (a) =>
          a.fullName.toLowerCase().includes(q) ||
          a.email.toLowerCase().includes(q) ||
          a.hotelName.toLowerCase().includes(q),
      )
    }
    return list
  }, [affiliates, filter, search])

  const totalOutstanding = useMemo(
    () => affiliates.reduce((sum, a) => sum + a.outstandingAmount, 0),
    [affiliates],
  )

  return (
    <div className="p-4 md:p-8 max-w-[1400px]">
      <div className="mb-5 md:mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Affiliate Payouts</h1>
        <p className="text-[13px] text-gray-500 mt-1">
          Track what vayada owes referrers across all hotels and record manual payouts
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4 mb-5">
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-5">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Total Outstanding</p>
          <p className="text-2xl font-bold text-gray-900">
            {formatAmount(totalOutstanding, affiliates[0]?.currency || 'EUR')}
          </p>
          <p className="text-[11px] text-gray-500 mt-1">
            {affiliates.filter((a) => a.outstandingAmount > 0).length} affiliates with unpaid balance
          </p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-5">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Total Affiliates</p>
          <p className="text-2xl font-bold text-gray-900">{affiliates.length}</p>
          <p className="text-[11px] text-gray-500 mt-1">Across all hotels</p>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl p-4 md:p-5">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Lifetime Paid Out</p>
          <p className="text-2xl font-bold text-gray-900">
            {formatAmount(affiliates.reduce((sum, a) => sum + a.paidAmount, 0), affiliates[0]?.currency || 'EUR')}
          </p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div className="flex gap-2">
          {(['outstanding', 'all'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-[12px] font-medium rounded-full border transition-colors ${filter === f ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                }`}
            >
              {f === 'outstanding' ? 'Outstanding only' : 'All affiliates'}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search by name, email or hotel..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full sm:w-72 px-3 py-2 text-[13px] border border-gray-200 rounded-lg bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-200"
        />
      </div>

      {loading ? (
        <div className="animate-pulse h-64 bg-gray-100 rounded-xl" />
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <p className="text-[13px] text-gray-500">{filter === 'outstanding' ? 'No outstanding payouts.' : 'No affiliates found.'}</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50/80">
                <th className="text-left  px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Affiliate</th>
                <th className="text-left  px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Hotel</th>
                <th className="text-left  px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Method</th>
                <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Outstanding</th>
                <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Lifetime paid</th>
                <th className="text-left  px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Last paid</th>
                <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((a) => (
                <tr key={a.affiliateId} className="hover:bg-gray-50/50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{a.fullName}</p>
                    <p className="text-[11px] text-gray-500">{a.email}</p>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{a.hotelName}</td>
                  <td className="px-4 py-3">
                    <span className="text-[11px] font-medium text-gray-600 bg-gray-100 px-2 py-0.5 rounded capitalize">{a.paymentMethod || '—'}</span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold text-gray-900">
                    {a.outstandingAmount > 0 ? formatAmount(a.outstandingAmount, a.currency) : '—'}
                    {a.unpaidCount > 0 && <span className="block text-[10px] text-gray-400 font-normal">{a.unpaidCount} bookings</span>}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{a.paidAmount > 0 ? formatAmount(a.paidAmount, a.currency) : '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(a.lastPaidAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setSelectedId(a.affiliateId)}
                      className="px-3 py-1 text-[12px] font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                    >
                      Details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedId && (
        <PayoutDetailDrawer affiliateId={selectedId} onClose={() => setSelectedId(null)} onPaid={() => { setSelectedId(null); fetchList() }} />
      )}
    </div>
  )
}

function PayoutDetailDrawer({ affiliateId, onClose, onPaid }: { affiliateId: string; onClose: () => void; onPaid: () => void }) {
  const [detail, setDetail] = useState<AffiliatePayoutDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [showPayForm, setShowPayForm] = useState(false)
  const [payMethod, setPayMethod] = useState('manual_bank')
  const [payRef, setPayRef] = useState('')
  const [payNotes, setPayNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    affiliatePayoutsService.get(affiliateId).then(setDetail).catch(() => setDetail(null)).finally(() => setLoading(false))
  }, [affiliateId])

  const handleMarkPaid = async () => {
    setSubmitting(true)
    setError('')
    try {
      await affiliatePayoutsService.markPaid(affiliateId, {
        paymentMethod: payMethod,
        externalReference: payRef.trim() || undefined,
        notes: payNotes.trim() || undefined,
      })
      onPaid()
    } catch (err: any) {
      setError(err?.message || 'Failed to record payout')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white w-full max-w-2xl h-full overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Affiliate payout details</h2>
            {detail && <p className="text-[12px] text-gray-500 mt-0.5">{detail.affiliate.fullName} · {detail.affiliate.hotelName}</p>}
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {loading || !detail ? (
          <div className="p-6"><div className="h-32 animate-pulse bg-gray-100 rounded-lg" /></div>
        ) : (
          <div className="p-6 space-y-6">
            <section>
              <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Payout method</h3>
              <div className="bg-gray-50 border border-gray-100 rounded-lg p-4 space-y-1.5 text-[13px]">
                <div><span className="text-gray-500">Method:</span> <span className="text-gray-900 capitalize">{detail.affiliate.paymentMethod}</span></div>
                {detail.affiliate.paymentMethod === 'paypal' && (
                  <div><span className="text-gray-500">PayPal email:</span> <span className="text-gray-900">{detail.affiliate.paypalEmail || '—'}</span></div>
                )}
                {detail.affiliate.paymentMethod === 'bank' && (
                  <>
                    <div><span className="text-gray-500">Holder:</span> <span className="text-gray-900">{detail.affiliate.bankAccountHolder || '—'}</span></div>
                    <div><span className="text-gray-500">IBAN:</span> <span className="text-gray-900 font-mono">{detail.affiliate.bankIban || '—'}</span></div>
                    <div><span className="text-gray-500">SWIFT/BIC:</span> <span className="text-gray-900 font-mono">{detail.affiliate.bankSwiftBic || '—'}</span></div>
                    <div><span className="text-gray-500">Bank:</span> <span className="text-gray-900">{detail.affiliate.bankName || '—'} ({detail.affiliate.bankCountry || '—'})</span></div>
                  </>
                )}
                {detail.affiliate.paymentMethod === 'stripe' && (
                  <>
                    <div><span className="text-gray-500">Account ID:</span> <span className="text-gray-900 font-mono">{detail.affiliate.stripeConnectAccountId || '—'}</span></div>
                    <div><span className="text-gray-500">Onboarded:</span> <span className="text-gray-900">{detail.affiliate.stripeConnectOnboarded ? 'Yes' : 'No'}</span></div>
                  </>
                )}
                <div className="pt-1 border-t border-gray-200 mt-2">
                  <span className="text-gray-500">Contact:</span> <span className="text-gray-900">{detail.affiliate.email}</span>
                </div>
              </div>
            </section>

            <section>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-semibold text-amber-700 uppercase tracking-wider">Outstanding</p>
                  <p className="text-2xl font-bold text-amber-900">{formatAmount(detail.outstandingAmount, detail.lines[0]?.currency || 'EUR')}</p>
                  <p className="text-[12px] text-amber-700 mt-0.5">{detail.lines.filter((l) => l.status !== 'completed').length} bookings unpaid</p>
                </div>
                {detail.outstandingAmount > 0 && !showPayForm && (
                  <button onClick={() => setShowPayForm(true)} className="px-4 py-2 text-[13px] font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors">Mark as paid</button>
                )}
              </div>

              {showPayForm && (
                <div className="mt-3 bg-white border border-gray-200 rounded-lg p-4 space-y-3">
                  {error && <div className="p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">{error}</div>}
                  <div>
                    <label className="block text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Payment method</label>
                    <select value={payMethod} onChange={(e) => setPayMethod(e.target.value)} className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-200">
                      {PAYMENT_METHOD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1">External reference</label>
                    <input type="text" value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="Bank txn id, Wise ref, PayPal txn..." className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-200" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1">Notes (optional)</label>
                    <textarea value={payNotes} onChange={(e) => setPayNotes(e.target.value)} rows={2} className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-200" />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button onClick={() => setShowPayForm(false)} disabled={submitting} className="px-4 py-2 text-[13px] font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50">Cancel</button>
                    <button onClick={handleMarkPaid} disabled={submitting} className="flex-1 px-4 py-2 text-[13px] font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50">
                      {submitting ? 'Recording...' : `Confirm ${formatAmount(detail.outstandingAmount, detail.lines[0]?.currency || 'EUR')} as paid`}
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section>
              <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Bookings</h3>
              {detail.lines.length === 0 ? (
                <p className="text-[13px] text-gray-500 bg-gray-50 border border-gray-100 rounded-lg p-4">No commission rows yet.</p>
              ) : (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="bg-gray-50/80 border-b border-gray-200">
                        <th className="text-left  px-3 py-2 font-medium text-[10px] text-gray-500 uppercase">Booking</th>
                        <th className="text-left  px-3 py-2 font-medium text-[10px] text-gray-500 uppercase">Stay</th>
                        <th className="text-right px-3 py-2 font-medium text-[10px] text-gray-500 uppercase">Total</th>
                        <th className="text-right px-3 py-2 font-medium text-[10px] text-gray-500 uppercase">Commission</th>
                        <th className="text-left  px-3 py-2 font-medium text-[10px] text-gray-500 uppercase">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {detail.lines.map((l) => (
                        <tr key={l.payoutId} className={l.status === 'completed' ? 'bg-emerald-50/30' : ''}>
                          <td className="px-3 py-2">
                            <p className="font-mono text-[10px] text-gray-700">{l.bookingReference}</p>
                            <p className="text-[10px] text-gray-500">{l.guestName}</p>
                          </td>
                          <td className="px-3 py-2 text-gray-600 text-[11px]">{formatDate(l.checkIn)} → {formatDate(l.checkOut)}</td>
                          <td className="px-3 py-2 text-right text-gray-600">{formatAmount(l.bookingTotal, l.currency)}</td>
                          <td className="px-3 py-2 text-right font-semibold text-gray-900">{formatAmount(l.commission, l.currency)}</td>
                          <td className="px-3 py-2">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium capitalize ${l.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : l.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                              }`}>{l.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {detail.history.length > 0 && (
              <section>
                <h3 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Payout history</h3>
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {detail.history.map((h, i) => (
                    <div key={i} className="px-4 py-3 text-[12px]">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold text-gray-900">{formatAmount(h.amount, h.currency)}</p>
                          <p className="text-[11px] text-gray-500">{h.bookingCount} bookings · {h.paymentMethod} · {formatDate(h.completedAt)}</p>
                        </div>
                        {h.externalReference && <p className="text-[10px] font-mono text-gray-400">{h.externalReference}</p>}
                      </div>
                      {h.notes && <p className="text-[11px] text-gray-500 mt-1">{h.notes}</p>}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
