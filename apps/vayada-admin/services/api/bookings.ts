import { apiClient } from "./client";

export type BookingStatus = "pending" | "accepted" | "rejected" | "withdrawn";

export interface SuperAdminBookingRow {
  id: string;
  bookingReference: string;
  hotelId: string;
  hotelName: string;
  hotelSlug: string;
  guestName: string;
  guestEmail: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  totalAmount: number;
  currency: string;
  status: BookingStatus;
  rawStatus: string;
  channel: string;
  requestedAt: string;
  respondedAt: string | null;
}

export const bookingsService = {
  list: (params?: { status?: BookingStatus; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.offset) qs.set("offset", String(params.offset));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return apiClient.get<{ bookings: SuperAdminBookingRow[] }>(
      `/api/platform/admin/bookings${suffix}`,
    );
  },
};
