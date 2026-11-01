import { describe, expect, it } from "vitest";

import { toLegacyHotel, type BookingWebPublicHotelResponse } from "./bookingWebPublic";

function publicHotelResponse(
  publicContacts?: BookingWebPublicHotelResponse["hotel"]["publicContacts"],
  images: BookingWebPublicHotelResponse["hotel"]["images"] = [],
): BookingWebPublicHotelResponse {
  return {
    hotel: {
      propertyId: "prop_alpenrose",
      slug: "hotel-alpenrose",
      name: "Hotel Alpenrose",
      canonicalUrl: "https://hotel-alpenrose.booking.localhost/en",
      bookingBaseUrl: "https://hotel-alpenrose.booking.localhost",
      customDomainUrl: null,
      timezone: "Europe/Vienna",
      defaultLocale: "en",
      supportedLocales: ["en", "de"],
      defaultCurrency: "EUR",
      supportedCurrencies: ["EUR"],
      location: {
        country: "AT",
        city: "Innsbruck",
        region: "Tyrol",
        latitude: null,
        longitude: null,
      },
      summary: "Independent alpine hotel.",
      images,
      amenities: ["wifi"],
      publicContacts,
      policies: {
        checkInFrom: "15:00",
        checkOutUntil: "11:00",
        cancellationSummary: null,
        termsUrl: null,
      },
      capabilities: {
        instantBook: true,
        onlinePayment: false,
        payAtProperty: true,
        promoCodes: false,
        bookingDeepLinks: true,
      },
      supportedQuoteParameters: {
        minRooms: 1,
        maxRooms: 5,
        minAdults: 1,
        maxAdults: 10,
        childrenSupported: true,
        adultAgeThreshold: 18,
        supportedCurrencies: ["EUR"],
        supportedLocales: ["en", "de"],
      },
    },
  };
}

describe("Booking Web public hotel adapter", () => {
  it("maps the Booking header logo and never uses it as the hero (VAY-2247)", () => {
    const response = publicHotelResponse();
    response.hotel.branding = {
      logoUrl: "https://cdn.vayada.example/alpenrose/logo.webp",
      heroImage: null,
      heroHeading: null,
      heroSubtext: null,
      primaryColor: null,
      fontPairing: null,
    };

    const hotel = toLegacyHotel(response);

    expect(hotel.branding?.logoUrl).toBe("https://cdn.vayada.example/alpenrose/logo.webp");
    expect(hotel.heroImage).toBeNull();
  });

  it("offers the published display currencies, else only the hotel currency", () => {
    const response = publicHotelResponse();
    expect(toLegacyHotel(response).displayCurrencies).toEqual(["EUR"]);

    response.hotel.branding = {
      displayCurrencies: ["EUR", "USD"],
      heroImage: null,
      heroHeading: null,
      heroSubtext: null,
      primaryColor: null,
      fontPairing: null,
    };
    const hotel = toLegacyHotel(response);

    expect(hotel.displayCurrencies).toEqual(["EUR", "USD"]);
    expect(hotel.currency).toBe("EUR");
    expect(hotel.displayDefaultCurrency).toBeNull();
  });

  it("maps the guest display currency the page opens in (VAY-2390)", () => {
    const response = publicHotelResponse();
    response.hotel.branding = {
      displayCurrencies: ["EUR", "USD"],
      displayDefaultCurrency: "USD",
      heroImage: null,
      heroHeading: null,
      heroSubtext: null,
      primaryColor: null,
      fontPairing: null,
    };
    const hotel = toLegacyHotel(response);

    expect(hotel.displayDefaultCurrency).toBe("USD");
    expect(hotel.currency).toBe("EUR");
  });

  it("maps header visibility", () => {
    const response = publicHotelResponse();
    response.hotel.branding = {
      logoUrl: null,
      showContactButton: false,
      showLanguageSelector: false,
      showCurrencySelector: true,
      showGalleryButton: false,
      heroImage: null,
      heroHeading: null,
      heroSubtext: null,
      primaryColor: null,
      fontPairing: null,
    };

    expect(toLegacyHotel(response)).toMatchObject({
      headerSettings: {
        showContactButton: false,
        showLanguageSelector: false,
        showCurrencySelector: true,
        showGalleryButton: false,
      },
    });
    // A profile without the switch keeps the Gallery button (VAY-2447).
    delete response.hotel.branding.showGalleryButton;
    expect(toLegacyHotel(response).headerSettings?.showGalleryButton).toBe(true);
  });

  it("tells the booking pages whether guests can use promo codes (VAY-2200)", () => {
    const response = publicHotelResponse();
    expect(toLegacyHotel(response).promoCodesEnabled).toBe(false);
    response.hotel.capabilities.promoCodes = true;
    expect(toLegacyHotel(response).promoCodesEnabled).toBe(true);
  });

  it("maps public contacts and uses only public city/region/country for the address", () => {
    const hotel = toLegacyHotel(
      publicHotelResponse([
        { type: "phone", value: " +43 512 555 0100 " },
        { type: "email", value: " stay@alpenrose.example " },
        { type: "whatsapp", value: "+43 660 555 0100" },
        { type: "website", value: "https://alpenrose.example" },
        { type: "instagram", value: "https://instagram.com/alpenrose" },
        { type: "facebook", value: "https://facebook.com/alpenrose" },
      ]),
    );

    expect(hotel.contact).toEqual({
      address: "Innsbruck, Tyrol, AT",
      phone: "+43 512 555 0100",
      email: "stay@alpenrose.example",
      whatsapp: "+43 660 555 0100",
      website: "https://alpenrose.example/",
    });
    expect(hotel.socialLinks).toEqual({
      instagram: "https://instagram.com/alpenrose",
      facebook: "https://facebook.com/alpenrose",
    });
  });

  it("passes the public map pin on only when it has both coordinates (VAY-2307)", () => {
    const response = publicHotelResponse();
    expect(toLegacyHotel(response).mapPin).toBeUndefined();
    response.hotel.location = { ...response.hotel.location, latitude: 47.27, longitude: 11.39 };
    expect(toLegacyHotel(response).mapPin).toEqual({ latitude: 47.27, longitude: 11.39 });
    response.hotel.location = { ...response.hotel.location, latitude: 47.27, longitude: null };
    expect(toLegacyHotel(response).mapPin).toBeUndefined();
    response.hotel.location = { ...response.hotel.location, latitude: 147.27, longitude: 11.39 };
    expect(toLegacyHotel(response).mapPin).toBeUndefined();
  });

  it("keeps missing contacts empty and rejects unsafe public-link schemes", () => {
    const empty = toLegacyHotel(publicHotelResponse([]));
    const omitted = toLegacyHotel(publicHotelResponse());
    const unsafe = toLegacyHotel(
      publicHotelResponse([
        { type: "website", value: "javascript:alert(1)" },
        { type: "instagram", value: "javascript:alert(2)" },
      ]),
    );

    expect(empty.contact).toEqual({
      address: "Innsbruck, Tyrol, AT",
      phone: "",
      email: "",
      whatsapp: undefined,
      website: undefined,
    });
    expect(empty.socialLinks).toEqual({ instagram: undefined, facebook: undefined });
    expect(omitted.contact).toEqual(empty.contact);
    expect(omitted.socialLinks).toEqual(empty.socialLinks);
    expect(unsafe.contact.website).toBeUndefined();
    expect(unsafe.socialLinks?.instagram).toBeUndefined();
  });

  it("keeps the hero separate from the property gallery", () => {
    const response = publicHotelResponse(undefined, [
      { url: "https://cdn.vayada.example/pool.jpg", alt: "Pool" },
      { url: "https://cdn.vayada.example/lobby.jpg", alt: "Lobby" },
    ]);
    response.hotel.branding = {
      heroImage: "https://cdn.vayada.example/hero.jpg",
      heroHeading: null,
      heroSubtext: null,
      primaryColor: null,
      fontPairing: null,
    };

    const hotel = toLegacyHotel(response);

    expect(hotel.heroImage).toBe("https://cdn.vayada.example/hero.jpg");
    expect(hotel.images).toEqual([
      "https://cdn.vayada.example/pool.jpg",
      "https://cdn.vayada.example/lobby.jpg",
    ]);
    // Without a hero photo the first gallery photo leads; without any photo the pages draw a placeholder.
    response.hotel.branding = undefined;
    expect(toLegacyHotel(response).heroImage).toBe("https://cdn.vayada.example/pool.jpg");
    expect(toLegacyHotel(publicHotelResponse()).images).toEqual([]);
    expect(toLegacyHotel(publicHotelResponse()).heroImage).toBeNull();
  });
});
