'use client'

import { useEffect, useState } from 'react'
import { ArrowTrendingUpIcon, ArrowTrendingDownIcon, PlusIcon } from '@heroicons/react/24/outline'
import { financialsService, FinancialsSummary } from '@/services/financials'
import { formatCurrency } from '@/lib/formatCurrency'
import { useTranslation } from '@/lib/i18n'
import InvoicesTab from '@/components/financials/InvoicesTab'
import PaymentsTab from '@/components/financials/PaymentsTab'

type Tab = 'invoices' | 'payments'

export default function FinancialsPage() {
  const { t } = useTranslation()
  const [summary, setSummary] = useState<FinancialsSummary | null>(null)
  const [tab, setTab] = useState<Tab>('invoices')

  useEffect(() => {
    financialsService.summary().then(setSummary).catch(console.error)
  }, [])

  return (
    <div className="p-4 md:p-6 pb-12">
      {/* Header */}
      <div className="mb-6 md:mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl md:text-xl font-bold text-gray-900">{t('financials.title')}</h1>
          <p className="text-sm text-gray-500 mt-1">{t('financials.subtitle')}</p>
        </div>
        <div className="flex items-stretch gap-3 flex-wrap md:flex-nowrap">
          <KpiCard
            label={t('financials.kpiRevenueMtd')}
            value={summary ? formatCurrency(summary.revenueMtd, summary.currency) : '—'}
            delta={summary?.revenueMtdDeltaPct ?? null}
            deltaLabel={
              summary?.revenueMtdDeltaPct != null
                ? t('financials.kpiRevenueDelta', { delta: String(summary.revenueMtdDeltaPct) })
                : null
            }
          />
          <KpiCard
            label={t('financials.kpiOutstanding')}
            value={summary ? formatCurrency(summary.outstanding, summary.currency) : '—'}
            sublabel={
              summary?.overdueCount
                ? t('financials.kpiOverdueCount', { count: String(summary.overdueCount) })
                : undefined
            }
            tone={summary && summary.outstanding > 0 ? 'warning' : 'neutral'}
          />
          <button
            type="button"
            disabled
            title={t('financials.createInvoiceComingSoon')}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-white bg-primary-600 disabled:bg-primary-300 disabled:cursor-not-allowed shadow-sm"
          >
            <PlusIcon className="w-4 h-4" />
            {t('financials.createInvoice')}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-5">
        <div className="flex items-center gap-1">
          {(['invoices', 'payments'] as Tab[]).map((id) => {
            const active = tab === id
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`relative px-3 py-2.5 text-sm transition-colors ${
                  active ? 'text-gray-900 font-semibold' : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                {t(id === 'invoices' ? 'financials.tabInvoices' : 'financials.tabPayments')}
                {active && <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-primary-600 rounded-full" />}
              </button>
            )
          })}
        </div>
      </div>

      {tab === 'invoices' ? <InvoicesTab /> : <PaymentsTab />}
    </div>
  )
}

function KpiCard({
  label,
  value,
  delta,
  deltaLabel,
  sublabel,
  tone = 'neutral',
}: {
  label: string
  value: string
  delta?: number | null
  deltaLabel?: string | null
  sublabel?: string
  tone?: 'neutral' | 'warning'
}) {
  const trendUp = (delta ?? 0) >= 0
  return (
    <div className={`flex flex-col justify-center min-w-[180px] px-4 py-3 rounded-xl border bg-white ${
      tone === 'warning' ? 'border-amber-200 bg-amber-50/40' : 'border-gray-200'
    }`}>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-lg font-bold text-gray-900 mt-0.5">{value}</p>
      {deltaLabel != null && (
        <p className={`flex items-center gap-1 text-[11px] mt-1 ${trendUp ? 'text-emerald-600' : 'text-rose-600'}`}>
          {trendUp ? (
            <ArrowTrendingUpIcon className="w-3 h-3" />
          ) : (
            <ArrowTrendingDownIcon className="w-3 h-3" />
          )}
          {deltaLabel}
        </p>
      )}
      {sublabel && (
        <p className="text-[11px] text-amber-700 mt-1 font-medium">{sublabel}</p>
      )}
    </div>
  )
}
