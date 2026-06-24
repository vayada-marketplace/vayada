export type ActivityType = "click" | "booking" | "signup";

export interface Activity {
  activityType: ActivityType;
  occurredAt: string;
  propertyName: string;
  count: number;
}

export interface ActivitiesResponse {
  contractVersion: "affiliate-dashboard.v1";
  affiliateId: string;
  activities: Activity[];
}
