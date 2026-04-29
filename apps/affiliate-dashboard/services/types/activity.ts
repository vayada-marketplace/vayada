/**
 * Shape returned by /affiliate/activity. Booking events have count=1;
 * click events are aggregated per (affiliate, day).
 */
export type ActivityType = 'click' | 'booking' | 'signup'

export interface Activity {
  type: ActivityType
  ts: string
  property: string
  count: number
}

export interface ActivitiesResponse {
  activities: Activity[]
}
