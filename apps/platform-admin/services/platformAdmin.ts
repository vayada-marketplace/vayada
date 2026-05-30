import { pmsApi } from "./api/client";

export type PlatformStatus = "live" | "demo" | "test";
export type Granularity = "daily" | "weekly" | "monthly";

export interface PlatformProperty {
  id: string;
  name: string;
  slug: string;
  status: PlatformStatus;
  createdAt: string;
}

export interface GrowthMetric {
  key: string;
  label: string;
  value: string;
  rawValue: number | null;
  delta: { value: number | null; label: string } | null;
}

export interface ChartPoint {
  key: string;
  label: string;
  value: number;
}

export interface GrowthDashboard {
  properties: PlatformProperty[];
  selectedPropertyIds: string[];
  excludeTestData: boolean;
  granularity: Granularity;
  bookingPropertyId: string | null;
  metrics: GrowthMetric[];
  pageViews: ChartPoint[];
  bookingRequests: ChartPoint[];
  liveProperties: ChartPoint[];
  emptyMessage: string | null;
}

export function getGrowthDashboard(params: {
  granularity: Granularity;
  excludeTestData: boolean;
  propertyIds?: string[];
  bookingPropertyId?: string;
}) {
  const search = new URLSearchParams({
    granularity: params.granularity,
    exclude_test_data: String(params.excludeTestData),
  });
  if (params.propertyIds) {
    if (params.propertyIds.length === 0) {
      search.append("property_ids", "");
    } else {
      params.propertyIds.forEach((id) => search.append("property_ids", id));
    }
  }
  if (params.bookingPropertyId) {
    search.set("booking_property_id", params.bookingPropertyId);
  }
  return pmsApi.get<GrowthDashboard>(`/platform-admin/growth?${search.toString()}`);
}

export function updatePropertyStatus(id: string, status: PlatformStatus) {
  return pmsApi.patch<PlatformProperty>(`/platform-admin/properties/${id}/status`, { status });
}
