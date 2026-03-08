'use client'

import { ReactNode } from 'react'

interface ModalProps {
  onClose: () => void
  maxWidth?: 'md' | 'lg'
  children: ReactNode
}

export default function Modal({ onClose, maxWidth = 'md', children }: ModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className={`relative bg-white rounded-xl shadow-xl w-full mx-4 p-6 max-h-[90vh] overflow-y-auto ${
        maxWidth === 'lg' ? 'max-w-lg' : 'max-w-md'
      }`}>
        {children}
      </div>
    </div>
  )
}
