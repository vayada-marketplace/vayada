'use client'

import { ReactNode } from 'react'

interface CardProps {
  title?: string
  children: ReactNode
  actions?: ReactNode
  className?: string
}

export function Card({ title, children, actions, className = '' }: CardProps) {
  return (
    <div className={`bg-white rounded-lg shadow-md border border-gray-200 ${className}`}>
      {(title || actions) && (
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          {title && <h3 className="text-lg font-semibold text-gray-900">{title}</h3>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="px-6 py-4">
        {children}
      </div>
    </div>
  )
}

