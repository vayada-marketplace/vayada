import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QuickBookingPagePreview, sampleStay } from "./QuickBookingPagePreview";

const today = new Date(2026, 9, 20); // Tue 20 Oct 2026

describe("QuickBookingPagePreview (VAY-2247)", () => {
  it("shows the hotel on the no-photo gradient, sample dates and its rooms with prices", () => {
    const markup = renderToStaticMarkup(
      <QuickBookingPagePreview
        url="alpenrose-munich.booking.vayada.com"
        hotelName="Hotel Alpenrose"
        place="Sendlinger Straße 12, Munich"
        rooms={[
          {
            name: "Classic Double",
            details: "Up to 2 guests · Free cancellation until 3 days before",
            price: "€145",
          },
        ]}
        today={today}
      />,
    );
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("alpenrose-munich.booking.vayada.com");
    expect(markup).toContain("from-[#8FA3BC] to-[#4B5B73]");
    expect(markup).toContain("Hotel Alpenrose");
    expect(markup).toContain("Sendlinger Straße 12, Munich");
    expect(markup).toContain("Fri 6 Nov");
    expect(markup).toContain("Sun 8 Nov");
    expect(markup).toContain("Classic Double");
    expect(markup).toContain("€145");
    expect(markup).not.toContain("Your first room");
    expect(markup).not.toContain(">Live<");
  });

  it("shows a faded placeholder room with the currency until the first room is there", () => {
    const markup = renderToStaticMarkup(
      <QuickBookingPagePreview
        url="yourhotel.booking.vayada.com"
        hotelName=""
        place=""
        rooms={[]}
        currencySymbol="€"
        today={today}
      />,
    );
    expect(markup).toContain("Your hotel");
    expect(markup).toContain("Your first room");
    expect(markup).toContain("Name, guests and price appear here");
    expect(markup).toContain("€ —");
    expect(markup).toContain("opacity-[0.45]");
  });

  it("marks a published page Live", () => {
    expect(
      renderToStaticMarkup(
        <QuickBookingPagePreview url="u" hotelName="H" place="P" rooms={[]} live today={today} />,
      ),
    ).toContain("Live");
  });

  it("picks the Friday about two weeks out and the Sunday after", () => {
    expect(sampleStay(today)).toEqual({ checkIn: "Fri 6 Nov", checkOut: "Sun 8 Nov" });
    expect(sampleStay(new Date(2026, 11, 25))).toEqual({
      checkIn: "Fri 8 Jan",
      checkOut: "Sun 10 Jan",
    });
    // A Friday itself: the stay starts exactly two weeks later.
    expect(sampleStay(new Date(2026, 9, 23))).toEqual({
      checkIn: "Fri 6 Nov",
      checkOut: "Sun 8 Nov",
    });
  });
});
