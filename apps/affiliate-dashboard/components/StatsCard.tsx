interface StatsCardProps {
  label: string
  value: string
  subtitle: string
  highlight?: boolean
}

export default function StatsCard({ label, value, subtitle, highlight }: StatsCardProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-sm transition-shadow">
      <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">{label}</p>
      <p className={`text-2xl sm:text-3xl font-bold ${highlight ? 'text-success-600' : 'text-gray-900'}`}>
        {value}
      </p>
      <p className="text-sm text-muted mt-1">{subtitle}</p>
    </div>
  )
}
