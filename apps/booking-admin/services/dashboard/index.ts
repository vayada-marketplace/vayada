import { apiClient } from '../api/client'

export interface DashboardStats {
  revenue: number
  revenue_previous: number
  bookings: number
  bookings_previous: number
  avg_nightly_rate: number
  avg_nightly_rate_previous: number
  page_views: number
  page_views_previous: number
  next_arrival: string | null
  live_since: string | null
}

export interface SourceBreakdown {
  source: string
  revenue: number
  percentage: number
  count: number
}

export interface BookingsBySource {
  total_revenue: number
  sources: SourceBreakdown[]
}

export interface FunnelStep {
  label: string
  value: number
  percentage: number
}

export interface ConversionFunnel {
  steps: FunnelStep[]
}

export interface Sparklines {
  revenue: number[]
  bookings: number[]
  avg_rate: number[]
  page_views: number[]
}

export interface PageViewBucket {
  date: string
  count: number
}

export interface PageViewsTimeline {
  window_start: string
  window_end: string
  previous_window_start: string
  previous_window_end: string
  buckets: PageViewBucket[]
  previous_buckets: PageViewBucket[]
  total: number
  previous_total: number
  has_previous_data: boolean
}

export type TimeRange = 'today' | 'week' | 'month'

export const dashboardService = {
  getStats: (range: TimeRange = 'today') =>
    apiClient.get<DashboardStats>(`/admin/dashboard/stats?range=${range}`),

  getBookingsBySource: (range: TimeRange = 'month') =>
    apiClient.get<BookingsBySource>(`/admin/dashboard/bookings-by-source?range=${range}`),

  getConversionFunnel: (range: TimeRange = 'month') =>
    apiClient.get<ConversionFunnel>(`/admin/dashboard/conversion-funnel?range=${range}`),

  getSparklines: (range: TimeRange = 'today') =>
    apiClient.get<Sparklines>(`/admin/dashboard/sparklines?range=${range}`),

  getPageViewsTimeline: (weekOffset = 0) =>
    apiClient.get<PageViewsTimeline>(`/admin/dashboard/page-views?week_offset=${weekOffset}`),
}
