import type { ReactNode } from 'react'

interface DataStateProps<T> {
  data: T | null
  error: boolean
  isEmpty?: (data: T) => boolean
  loadingLabel?: string
  errorLabel?: string
  emptyLabel?: string
  loadingClassName?: string
  errorClassName?: string
  emptyClassName?: string
  children: (data: T) => ReactNode
}

const DEFAULT_MSG_CLASSNAME = 'text-sm text-muted py-4'

export default function DataState<T>({
  data,
  error,
  isEmpty,
  loadingLabel = 'Loading…',
  errorLabel = "Couldn't load.",
  emptyLabel = 'Nothing to show yet.',
  loadingClassName = DEFAULT_MSG_CLASSNAME,
  errorClassName = DEFAULT_MSG_CLASSNAME,
  emptyClassName = DEFAULT_MSG_CLASSNAME,
  children,
}: DataStateProps<T>) {
  if (error) return <p className={errorClassName}>{errorLabel}</p>
  if (data === null) return <p className={loadingClassName}>{loadingLabel}</p>
  if (isEmpty?.(data)) return <p className={emptyClassName}>{emptyLabel}</p>
  return <>{children(data)}</>
}
