import { Hotel, RoomType, Addon } from "@/lib/types";
import { bookingEngine, bookingWebPublic, pmsApi } from "./client";
import {
  bookingWebPublicApi,
  defaultOfferDates,
  toLegacyCalendar,
  toLegacyHotel,
  toLegacyRooms,
} from "./bookingWebPublic";
import { getBookingWebSessionId } from "./session";

export const hotelService = {
  async getHotel(slug: string, locale: string = "en"): Promise<Hotel> {
    try {
      return toLegacyHotel(await bookingWebPublicApi.getHotel(slug, { locale }));
    } catch {
      return bookingEngine.get<Hotel>(
        `/api/hotels/${encodeURIComponent(slug)}?lang=${encodeURIComponent(locale)}`,
      );
    }
  },

  async recordAffiliateClick(slug: string, referralCode: string): Promise<void> {
    try {
      await fetch(
        `${bookingWebPublic.baseURL}/api/booking-web/hotels/${encodeURIComponent(slug)}/attribution/clicks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            referralCode,
            sessionId: getBookingWebSessionId(),
            landingUrl: typeof window === "undefined" ? undefined : window.location.href,
            referrer: typeof document === "undefined" ? undefined : document.referrer,
          }),
          keepalive: true,
        },
      );
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
    try {
      const data = await bookingWebPublicApi.getOffers(slug, {
        checkIn: dates.checkIn,
        checkOut: dates.checkOut,
        adults,
        children,
        rooms: 1,
        locale,
      });
      return toLegacyRooms(data);
    } catch {
      const params = new URLSearchParams({
        check_in: dates.checkIn,
        check_out: dates.checkOut,
      });
      if (adults !== undefined) params.set("adults", String(adults));
      if (children !== undefined) params.set("children", String(children));
      return pmsApi.get<RoomType[]>(
        `/api/hotels/${encodeURIComponent(slug)}/rooms?${params.toString()}`,
      );
    }
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
      try {
        const params = new URLSearchParams({ start, end });
        const data = await pmsApi.get<{
          dates?: string[];
          minStayByArrival?: Record<string, number>;
          min_stay_by_arrival?: Record<string, number>;
          maxStayByArrival?: Record<string, number>;
          max_stay_by_arrival?: Record<string, number>;
        }>(`/api/hotels/${encodeURIComponent(slug)}/unavailable-dates?${params.toString()}`);
        return {
          dates: data.dates || [],
          minStayByArrival: data.minStayByArrival || data.min_stay_by_arrival || {},
          maxStayByArrival: data.maxStayByArrival || data.max_stay_by_arrival || {},
        };
      } catch {
        return { dates: [], minStayByArrival: {}, maxStayByArrival: {} };
      }
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
    try {
      return await bookingWebPublic.post(
        `/api/booking-web/hotels/${encodeURIComponent(slug)}/promo/validate`,
        { code },
      );
    } catch {
      return bookingEngine.get(
        `/api/hotels/${encodeURIComponent(slug)}/validate-promo?code=${encodeURIComponent(code)}`,
      );
    }
  },
};
