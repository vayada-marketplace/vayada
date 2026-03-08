'use client'

interface PaginationProps {
  total: number
  limit: number
  offset: number
  onOffsetChange: (offset: number) => void
}

export default function Pagination({ total, limit, offset, onOffsetChange }: PaginationProps) {
  if (total <= limit) return null

  return (
    <div className="flex items-center justify-between mt-4">
      <p className="text-sm text-gray-500">
        Showing {offset + 1}&ndash;{Math.min(offset + limit, total)} of {total}
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
          disabled={offset === 0}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50"
        >
          Previous
        </button>
        <button
          onClick={() => onOffsetChange(offset + limit)}
          disabled={offset + limit >= total}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-40 hover:bg-gray-50"
        >
          Next
        </button>
      </div>
    </div>
  )
}
