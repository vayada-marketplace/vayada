import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { PropertySection } from "./PropertySection";

async function render(timezone: string) {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      createElement(PropertySection, {
        timezone,
        setTimezone: vi.fn(),
        country: "LK",
        setCountry: vi.fn(),
        saving: false,
        loadStatus: "ready",
        loadError: "",
        onRetry: vi.fn(),
        onSave: vi.fn(),
      }),
    );
  });
  return view;
}
const zones = (view: ReactTestRenderer) =>
  view.root
    .findByProps({ id: "pms-property-timezone" })
    .findAllByType("option")
    .map((option) => option.props.value as string)
    .filter(Boolean);

describe("PMS Settings › Property time zone (VAY-2582)", () => {
  it("offers every IANA time zone a hotel can have, Asia/Colombo too, once each", async () => {
    const view = await render("Asia/Colombo");
    const offered = zones(view);
    expect(offered).toContain("Asia/Colombo");
    expect(offered).toEqual(expect.arrayContaining(["Asia/Makassar", "Europe/London", "Etc/UTC"]));
    expect(offered.length).toBeGreaterThan(300);
    expect(new Set(offered).size).toBe(offered.length);
    expect(view.root.findByProps({ id: "pms-property-timezone" }).props.value).toBe("Asia/Colombo");
    view.unmount();
  });

  it("keeps a saved time zone the list doesn't name", async () => {
    const view = await render("Test/Unlisted_Zone");
    expect(zones(view)[0]).toBe("Test/Unlisted_Zone");
    view.unmount();
  });
});
