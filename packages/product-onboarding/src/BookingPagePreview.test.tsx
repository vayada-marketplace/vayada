import { create } from "react-test-renderer";
import { describe, expect, it } from "vitest";

import { BookingPagePreview } from "./BookingPagePreview";

const font = { headingFamily: "'Inter', sans-serif", bodyFamily: "'Inter', sans-serif" };

describe("BookingPagePreview", () => {
  it("renders the shared Design Studio preview with live brand and localization values", () => {
    const renderer = create(
      <BookingPagePreview
        currency="CHF"
        defaultLanguage="de"
        font={font}
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
        font={font}
        heroHeading="Hotel One"
        heroImage=""
        heroSubtext="A quiet stay in the mountains."
        primaryColor="#2D6A4F"
        propertyName="Hotel One"
        showContactButton={false}
        showLanguageSelector={false}
        showCurrencySelector
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

    expect(text).not.toContain("Contact");
    expect(headerSelectors).toHaveLength(1);
    expect(headerSelectors[0]?.children).toContain("CHF");
  });

  it("auto-hides header selectors when only one option is configured", () => {
    const renderer = create(
      <BookingPagePreview
        currency="CHF"
        defaultLanguage="de"
        font={font}
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

  it("shows the Gallery pill first in the header only when asked (VAY-2447)", () => {
    const headerTexts = (showGalleryButton?: boolean) => {
      const renderer = create(
        <BookingPagePreview
          currency="CHF"
          defaultLanguage="de"
          font={font}
          heroHeading="Hotel One"
          heroImage=""
          heroSubtext="A quiet stay in the mountains."
          primaryColor="#2D6A4F"
          propertyName="Hotel One"
          showGalleryButton={showGalleryButton}
        />,
      );
      // The header's actions, left to right.
      const actions = renderer.root.findAll(
        (node) => node.type === "div" && node.props.className === "flex items-center gap-1.5",
      )[0]!;
      return actions
        .findAllByType("span")
        .map((node) => node.children.filter((child) => typeof child === "string").join(""));
    };

    expect(headerTexts()).not.toContain("Gallery");
    expect(headerTexts(false)).not.toContain("Gallery");
    expect(headerTexts(true)).toEqual(["Gallery", "Contact", "DE", "CHF"]);
  });
});
