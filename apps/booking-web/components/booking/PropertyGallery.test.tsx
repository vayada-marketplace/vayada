/** @vitest-environment jsdom */

import type { ComponentProps } from "react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import deMessages from "../../messages/de.json";
import enMessages from "../../messages/en.json";
import PropertyGallery from "./PropertyGallery";

vi.mock("next/image", () => ({
  default: ({ fill, priority, quality, ...props }: ImageProps) => {
    void fill;
    void priority;
    void quality;
    return createElement("img", props);
  },
}));

type ImageProps = ComponentProps<"img"> & {
  fill?: boolean;
  priority?: boolean;
  quality?: number;
};

describe("PropertyGallery", () => {
  let root: Root | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<button id="behind">Behind modal</button><div id="root"></div>';
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    document.body.innerHTML = "";
  });

  it("does not render a trigger when the property has no gallery photos", () => {
    expect(renderGalleryToMarkup("en", [])).toBe("");
  });

  it("skips duplicate and empty photo links", () => {
    renderInteractiveGallery([
      "https://cdn.vayada.com/gallery-1.webp",
      "",
      "https://cdn.vayada.com/gallery-2.webp",
      "https://cdn.vayada.com/gallery-1.webp",
    ]);
    act(() => button("Open photo gallery").click());

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("1 / 2");
  });

  it("caps the guest-facing gallery at ten photos", () => {
    renderInteractiveGallery(
      Array.from({ length: 12 }, (_, index) => `https://cdn.vayada.com/gallery-${index + 1}.webp`),
    );
    act(() => button("Open photo gallery").click());

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("1 / 10");
  });

  it("labels the nav pill Gallery and names the button for screen readers", () => {
    const markup = renderGalleryToMarkup("en", ["https://cdn.vayada.com/gallery.webp"]);

    expect(markup).toContain('aria-label="Open photo gallery"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toMatch(/Gallery<\/button>$/);
  });

  it("shows only the icon in the compact phone nav", () => {
    const container = document.createElement("div");
    container.innerHTML = renderGalleryToMarkup(
      "en",
      ["https://cdn.vayada.com/gallery.webp"],
      true,
    );
    const trigger = container.querySelector("button");

    expect(trigger?.getAttribute("aria-label")).toBe("Open photo gallery");
    expect(trigger?.textContent).toBe("");
  });

  it("renders guest controls in the requested locale", () => {
    const markup = renderGalleryToMarkup("de", ["https://cdn.vayada.com/gallery.webp"]);

    expect(markup).toContain('aria-label="Galerie öffnen"');
    expect(markup).toMatch(/Galerie<\/button>$/);
  });

  it("keeps keyboard focus inside the open modal", () => {
    renderInteractiveGallery();
    const trigger = button("Open photo gallery");
    act(() => trigger.click());

    const close = button("Close our photo gallery");
    const next = button("Next photo of our property");
    expect(document.activeElement).toBe(close);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(next);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(close);
    expect(document.activeElement).not.toBe(document.querySelector("#behind"));
  });

  it("shows a placeholder card instead of alt text when a photo fails to load", () => {
    renderInteractiveGallery();
    act(() => button("Open photo gallery").click());

    const photo = document.querySelector("img");
    expect(photo?.getAttribute("src")).toBe("https://cdn.vayada.com/gallery-1.webp");
    act(() => {
      photo?.dispatchEvent(new Event("error"));
    });

    expect(document.querySelector("img")).toBeNull();
    expect(
      document.querySelector('[role="img"][aria-label="Our photo 1 of Hotel Alpenrose"]'),
    ).not.toBeNull();

    act(() => button("Next photo of our property").click());
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "https://cdn.vayada.com/gallery-2.webp",
    );

    act(() => button("Close our photo gallery").click());
    act(() => button("Open photo gallery").click());
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "https://cdn.vayada.com/gallery-1.webp",
    );
  });

  function renderInteractiveGallery(
    images = ["https://cdn.vayada.com/gallery-1.webp", "https://cdn.vayada.com/gallery-2.webp"],
  ) {
    const container = document.querySelector("#root");
    if (!(container instanceof HTMLElement)) throw new Error("Missing test root");
    root = createRoot(container);
    act(() => {
      root?.render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <PropertyGallery hotelName="Hotel Alpenrose" images={images} />
        </NextIntlClientProvider>,
      );
    });
  }
});

function renderGalleryToMarkup(locale: "de" | "en", images: string[], compact = false) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "de" ? deMessages : enMessages}>
      <PropertyGallery hotelName="Hotel Alpenrose" images={images} compact={compact} />
    </NextIntlClientProvider>,
  );
}

function button(label: string): HTMLButtonElement {
  const element = Array.from(document.querySelectorAll("button")).find(
    (candidate) =>
      candidate.textContent === label || candidate.getAttribute("aria-label") === label,
  );
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return element;
}
