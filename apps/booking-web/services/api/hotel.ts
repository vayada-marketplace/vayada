import { Hotel, RoomType, Addon } from "@/lib/types";
import { bookingEngine, pms } from "./client";
import {
  bookingWebPublicApi,
  defaultOfferDates,
  toLegacyCalendar,
  toLegacyHotel,
  toLegacyRooms,
} from "./bookingWebPublic";

export const hotelService = {
  async getHotel(slug: string, locale: string = "en"): Promise<Hotel> {
    return toLegacyHotel(await bookingWebPublicApi.getHotel(slug, { locale }));
  },

  async recordAffiliateClick(slug: string, referralCode: string): Promise<void> {
    try {
      await fetch(`${pms.baseURL}/api/hotels/${slug}/affiliates/${referralCode}/click`, {
        method: "POST",
        keepalive: true,
      });
    } catch {
      // Click tracking is best-effort — never block UX on it.
    }
  },

  async getRooms(
    slug: string,
    checkIn?: string,
    checkOut?: string,
    adults?: number,
    children?: number,
    locale?: string,
  ): Promise<RoomType[]> {
    const dates = checkIn && checkOut ? { checkIn, checkOut } : defaultOfferDates();
    const params = new URLSearchParams();
    params.set("check_in", dates.checkIn);
    params.set("check_out", dates.checkOut);
    if (adults) params.set("adults", String(adults));
    if (children !== undefined) params.set("children", String(children));
    const qs = params.toString();
    const [data, displayRooms] = await Promise.all([
      bookingWebPublicApi.getOffers(slug, {
        checkIn: dates.checkIn,
        checkOut: dates.checkOut,
        adults,
        children,
        rooms: 1,
        locale,
      }),
      pms.get<RoomType[]>(`/api/hotels/${slug}/rooms${qs ? `?${qs}` : ""}`).catch(() => []),
    ]);
    return toLegacyRooms(data, displayRooms);
  },

  async getAddons(slug: string): Promise<Addon[]> {
    return bookingEngine.get<Addon[]>(`/api/hotels/${slug}/addons`);
  },

  async getUnavailableDates(
    slug: string,
    start: string,
    end: string,
  ): Promise<{
    dates: string[];
    minStayByArrival: Record<string, number>;
    maxStayByArrival: Record<string, number>;
  }> {
    try {
      return toLegacyCalendar(await bookingWebPublicApi.getCalendar(slug, start, end));
    } catch {
      return { dates: [], minStayByArrival: {}, maxStayByArrival: {} };
    }
  },

  async validatePromoCode(
    slug: string,
    code: string,
  ): Promise<{
    valid: boolean;
    code: string;
    discountType?: string;
    discountValue?: number;
    message: string;
  }> {
    return bookingEngine.get(`/api/hotels/${slug}/validate-promo?code=${encodeURIComponent(code)}`);
  },
};
