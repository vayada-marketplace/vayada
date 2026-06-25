import {
  assertPmsOperationsReadModelEnabled,
  pmsOperationsClient,
  pmsOperationsRequestOptions,
} from "./pmsOperationsClient";

export interface PmsPropertySummary {
  id: string;
  name: string;
  slug: string;
  location: string;
  country: string;
}

export interface PmsPropertyProfile extends PmsPropertySummary {
  timezone: string;
  instant_book?: boolean;
  instantBook?: boolean;
  same_day_bookings_enabled?: boolean;
  sameDayBookingsEnabled?: boolean;
  same_day_booking_cutoff_time?: string | null;
  sameDayBookingCutoffTime?: string | null;
}

export interface PmsCalendarSettings {
  autoRearrangeEnabled: boolean;
  autoOpenEnabled: boolean;
  autoOpenMode: "rolling" | "fixed";
  autoOpenMonths: 12 | 18 | 24;
  autoOpenFixedMonth: string | null;
  autoOpenThrough: string | null;
  autoOpenWarnings: string[];
}

export async function listPmsProperties(): Promise<PmsPropertySummary[]> {
  assertPmsOperationsReadModelEnabled();
  return pmsOperationsClient.get<PmsPropertySummary[]>(
    "/api/pms/properties",
    pmsOperationsRequestOptions,
  );
}

export async function resolveSelectedPmsPropertyId(action = "loading PMS data"): Promise<string> {
  const properties = await listPmsProperties();
  const storedPropertyId =
    typeof window !== "undefined" ? localStorage.getItem("selectedHotelId")?.trim() : "";
  const selected =
    properties.find((property) => property.id === storedPropertyId) ?? properties[0] ?? null;
  if (!selected) {
    throw new Error(`Select a PMS property before ${action}.`);
  }

  if (typeof window !== "undefined" && storedPropertyId !== selected.id) {
    localStorage.setItem("selectedHotelId", selected.id);
  }
  return selected.id;
}

export async function getPmsPropertyProfile(): Promise<PmsPropertyProfile> {
  const propertyId = await resolveSelectedPmsPropertyId("loading property settings");
  return pmsOperationsClient.get<PmsPropertyProfile>(
    propertyEndpoint(propertyId, "profile"),
    pmsOperationsRequestOptions,
  );
}

export async function updatePmsPropertyProfile(
  data: Partial<PmsPropertyProfile>,
): Promise<PmsPropertyProfile> {
  const propertyId = await resolveSelectedPmsPropertyId("saving property settings");
  return pmsOperationsClient.patch<PmsPropertyProfile>(
    propertyEndpoint(propertyId, "profile"),
    data,
    pmsOperationsRequestOptions,
  );
}

export async function getPmsCalendarSettings(): Promise<PmsCalendarSettings> {
  const propertyId = await resolveSelectedPmsPropertyId("loading calendar settings");
  return pmsOperationsClient.get<PmsCalendarSettings>(
    propertyEndpoint(propertyId, "calendar-settings"),
    pmsOperationsRequestOptions,
  );
}

export async function updatePmsCalendarSettings(
  data: Partial<PmsCalendarSettings>,
): Promise<PmsCalendarSettings> {
  const propertyId = await resolveSelectedPmsPropertyId("saving calendar settings");
  return pmsOperationsClient.patch<PmsCalendarSettings>(
    propertyEndpoint(propertyId, "calendar-settings"),
    data,
    pmsOperationsRequestOptions,
  );
}

export async function getPmsMessagingUnreadCount(): Promise<{ unreadCount: number }> {
  const propertyId = await resolveSelectedPmsPropertyId("loading unread messages");
  return pmsOperationsClient.get<{ unreadCount: number }>(
    propertyEndpoint(propertyId, "messaging/unread-count"),
    pmsOperationsRequestOptions,
  );
}

export function propertyEndpoint(propertyId: string, suffix: string): string {
  return `/api/pms/properties/${encodeURIComponent(propertyId)}/${suffix}`;
}
