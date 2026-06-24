import { ApiClient, API_BASE_URL } from "./client";

const BOOKING_API_URL = process.env.NEXT_PUBLIC_BOOKING_API_URL || API_BASE_URL;

export const bookingApiClient = new ApiClient(BOOKING_API_URL);

export function hotelHeaders(hotelId: string): RequestInit {
  return { headers: { "X-Hotel-Id": hotelId } };
}
