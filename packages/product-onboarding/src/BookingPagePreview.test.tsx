import { create } from "react-test-renderer";
import { describe, expect, it } from "vitest";

import { BookingPagePreview } from "./BookingPagePreview";
import { BOOKING_PAGE_FONT_PAIRINGS } from "./bookingPageBranding";

describe("BookingPagePreview", () => {
  it("renders the shared Design Studio preview with live brand and localization values", () => {
    const renderer = create(
      <BookingPagePreview
        currency="CHF"
        defaultLanguage="de"
        font={BOOKING_PAGE_FONT_PAIRINGS[1]}
        heroHeading="Hotel One"
        heroImage=""
        heroSubtext="A quiet stay in the mountains."
        primaryColor="#2D6A4F"
        propertyName="Hotel One"
      />,
    );
    const text = renderer.root
      .findAll((node) => typeof node.children[0] === "string")
      .flatMap((node) => node.children)
      .join(" ");

    expect(text).toContain("Hotel One");
    expect(text).toContain("A quiet stay in the mountains.");
    expect(text).toContain("DE");
    expect(text).toContain("CHF");
    expect(text).toContain("Available Accommodations");
  });

  it("reflects hidden header controls immediately", () => {
    const renderer = create(
      <BookingPagePreview
        currency="CHF"
        defaultLanguage="de"
        font={BOOKING_PAGE_FONT_PAIRINGS[1]}
        heroHeading="Hotel One"
        heroImage=""
        heroSubtext="A quiet stay in the mountains."
        primaryColor="#2D6A4F"
        propertyName="Hotel One"
        showContactButton={false}
        showLanguageSelector={false}
        showCurrencySelector
        showReferAGuestButton
      />,
    );
    const text = renderer.root
      .findAll((node) => typeof node.children[0] === "string")
      .flatMap((node) => node.children)
      .join(" ");
    const headerSelectors = renderer.root.findAll(
      (node) =>
        typeof node.props.className === "string" &&
        node.props.className.includes("border-white/60") &&
        (node.children.includes("DE") || node.children.includes("CHF")),
    );
    const refer = renderer.root.findByProps({ "data-testid": "booking-preview-refer" });

    expect(text).not.toContain("Contact");
    expect(headerSelectors).toHaveLength(1);
    expect(headerSelectors[0]?.children).toContain("CHF");
    expect(text).toContain("Refer a Guest");
    expect(refer.props.className).not.toContain("hidden");
  });

  it("auto-hides header selectors when only one option is configured", () => {
    const renderer = create(
      <BookingPagePreview
        currency="CHF"
        defaultLanguage="de"
        font={BOOKING_PAGE_FONT_PAIRINGS[1]}
        heroHeading="Hotel One"
        heroImage=""
        heroSubtext="A quiet stay in the mountains."
        primaryColor="#2D6A4F"
        propertyName="Hotel One"
        supportedCurrencies={["CHF"]}
        supportedLanguages={["de"]}
      />,
    );
    const headerSelectors = renderer.root.findAll(
      (node) =>
        typeof node.props.className === "string" &&
        node.props.className.includes("border-white/60") &&
        (node.children.includes("DE") || node.children.includes("CHF")),
    );

    expect(headerSelectors).toHaveLength(0);
  });
});
