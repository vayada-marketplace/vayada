import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import enMessages from "../../messages/en.json";
import BookingFooter from "./BookingFooter";

const hotel = vi.hoisted(() => ({ description: "" }));

vi.mock("@/contexts/HotelContext", () => ({
  useHotel: () => ({
    hotel: {
      name: "Hotel Alpenrose",
      description: hotel.description,
      contact: {
        address: "Alpenstrasse 12, Munich",
        phone: "+49 89 5550 1234",
        email: "stay@alpenrose.example",
      },
      socialLinks: {},
    },
  }),
}));
vi.mock("@/components/booking/FindBookingModal", () => ({ default: () => null }));

function renderFooter(description: string) {
  hotel.description = description;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BookingFooter />
    </NextIntlClientProvider>,
  );
}

describe("BookingFooter", () => {
  it("shows the hotel description under the name", () => {
    const html = renderFooter("A family-run alpine hotel in the heart of Munich.");
    expect(html).toContain("A family-run alpine hotel in the heart of Munich.");
  });

  it("hides the description line when there is none (VAY-2142)", () => {
    for (const description of ["", "   "]) {
      const html = renderFooter(description);
      expect(html).toContain("Hotel Alpenrose");
      expect(html).not.toContain("text-white/80 text-sm leading-relaxed");
    }
  });
});
