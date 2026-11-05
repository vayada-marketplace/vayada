import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import enMessages from "../../messages/en.json";
import BookingFooter from "./BookingFooter";

const hotel = vi.hoisted(() => ({ description: "", whatsapp: undefined as string | undefined }));

vi.mock("@/contexts/HotelContext", () => ({
  useHotel: () => ({
    hotel: {
      name: "Hotel Alpenrose",
      description: hotel.description,
      contact: {
        address: "Alpenstrasse 12, Munich",
        phone: "+49 89 5550 1234",
        email: "stay@alpenrose.example",
        whatsapp: hotel.whatsapp,
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

  it("offers the guest's privacy choices (VAY-2419)", () => {
    expect(renderFooter("")).toContain(">Privacy choices</button>");
  });

  it("opens WhatsApp with the number's digits only, as the Contact menu does (VAY-2473)", () => {
    try {
      hotel.whatsapp = "+62 823 4196 3715";
      expect(renderFooter("")).toContain('href="https://wa.me/6282341963715"');
      // No digits, no link: never a bare https://wa.me/.
      hotel.whatsapp = "on request";
      expect(renderFooter("")).not.toContain("wa.me");
    } finally {
      hotel.whatsapp = undefined;
    }
  });
});
