import { Hotel, Addon } from "@/lib/types";
import { bookingWebPublic } from "./client";
import { bookingWebPublicApi, toLegacyHotel } from "./bookingWebPublic";
import { getBookingWebSessionId } from "./session";

export const hotelService = {
  async getHotel(slug: string, locale: string = "en"): Promise<Hotel> {
    return toLegacyHotel(await bookingWebPublicApi.getHotel(slug, { locale }));
  },

  async recordAffiliateClick(slug: string, referralCode: string, clickId: string): Promise<void> {
    try {
      await fetch(
        `${bookingWebPublic.baseURL}/api/booking-web/hotels/${encodeURIComponent(slug)}/attribution/clicks`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Only the referring site: page addresses can carry a guest's email, booking
          // reference or access token (VAY-2215). no-referrer keeps the Referer header from
          // sending this page's own address.
          body: JSON.stringify({
            clickId,
            referralCode,
            sessionId: getBookingWebSessionId(slug),
            referrer: referrerOrigin(),
          }),
          keepalive: true,
          referrerPolicy: "no-referrer",
        },
      );
    } catch {
      // Click tracking is best-effort — never block UX on it.
    }
  },

  async getAddons(slug: string): Promise<Addon[]> {
    const config = await bookingWebPublic.get<{ addons: Addon[] }>(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/checkout-config`,
    );
    return config.addons ?? [];
  },

  async validatePromoCode(
    slug: string,
    code: string,
    context: {
      checkIn?: string;
      roomTypeId?: string;
      bookingTotal?: number;
    } = {},
  ): Promise<{
    valid: boolean;
    code: string;
    discountType?: string;
    discountValue?: number;
    currency?: string;
    message: string;
  }> {
    return bookingWebPublic.post(
      `/api/booking-web/hotels/${encodeURIComponent(slug)}/promo/validate`,
      { code, ...context },
    );
  },
};

function referrerOrigin(): string | undefined {
  if (typeof document === "undefined" || !document.referrer) return undefined;
  try {
    const url = new URL(document.referrer);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
