/**
 * SWR fetcher backed by ApiClient. Use as the global fetcher in
 * SWRConfig — useSWR<T>('/affiliate/dashboard') returns DashboardStats.
 *
 * 401s are translated by ApiClient into a redirect to /login (and the
 * thrown ApiErrorResponse is what SWR sees as `error`), so SWR consumers
 * don't need to handle the auth-expiry case themselves.
 */
import { apiClient } from './client'

export const fetcher = <T>(url: string): Promise<T> => apiClient.get<T>(url)
