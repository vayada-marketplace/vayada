import { createElement } from "react";
import { create, act, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { AirbnbImportLink } from "./AirbnbImportLink";
const id = "10090000-0000-4000-8000-000000000001";
let view: ReactTestRenderer;
afterEach(() => {
  act(() => view?.unmount());
  vi.unstubAllEnvs();
});
function render(propertyId = id) {
  act(() => {
    view = create(createElement(AirbnbImportLink, { propertyId }));
  });
}
it("is hidden by default", () => {
  vi.stubEnv("NEXT_PUBLIC_AIRBNB_IMPORT_ENABLED", "");
  render();
  expect(view.toJSON()).toBeNull();
});
it("opens authentication with the selected property as its return destination", () => {
  vi.stubEnv("NEXT_PUBLIC_AIRBNB_IMPORT_ENABLED", "true");
  vi.stubEnv("NEXT_PUBLIC_MARKETPLACE_URL", "https://marketplace.localhost:1382");
  render();
  const link = view.root.findByType("a");
  const url = new URL(link.props.href);
  expect(url.origin).toBe("https://marketplace.localhost:1382");
  expect(url.pathname).toBe("/login");
  expect(url.searchParams.get("returnTo")).toBe(`/setup/airbnb-connect/${id}`);
  expect(link.props.target).toBe("_blank");
  expect(link.props.rel).toBe("noopener noreferrer");
});
it.each(["http://other.test", "javascript:alert(1)", "invalid", "https://user:pass@other.test"])(
  "hides invalid configuration %s",
  (origin) => {
    vi.stubEnv("NEXT_PUBLIC_AIRBNB_IMPORT_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_MARKETPLACE_URL", origin);
    render();
    expect(view.toJSON()).toBeNull();
  },
);
it("does not build a link without a canonical property", () => {
  vi.stubEnv("NEXT_PUBLIC_AIRBNB_IMPORT_ENABLED", "true");
  render("invalid");
  expect(view.toJSON()).toBeNull();
});

it.each([undefined, ""])(
  "hides the entry without a configured Marketplace origin: %s",
  (origin) => {
    vi.stubEnv("NEXT_PUBLIC_AIRBNB_IMPORT_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_MARKETPLACE_URL", origin);
    render();
    expect(view.toJSON()).toBeNull();
  },
);
