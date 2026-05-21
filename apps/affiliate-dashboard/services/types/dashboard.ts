/**
 * Mirrors DashboardStats in pms-backend/app/routers/affiliate_dashboard.py
 */
export interface DashboardStats {
  totalEarned: number
  totalBookings: number
  totalClicks: number
  conversionRate: number
  propertyCount: number
  outstandingBalance: number
}
