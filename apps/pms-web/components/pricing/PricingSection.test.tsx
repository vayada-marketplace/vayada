import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PricingSection } from "./PricingSection";

let view: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("React", React);
});
afterEach(() => {
  act(() => view.unmount());
  vi.unstubAllGlobals();
});
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
const mount = (props: { label?: string; value?: string }) => {
  act(() => {
    view = create(
      <PricingSection title="Seasonal prices" {...props}>
        <input aria-label="Season name for Alpine Suite Offer 1" />
      </PricingSection>,
    );
  });
};

it("shows a short title, keeps room and offer for screen readers, and keeps closed content mounted (VAY-2122)", () => {
  mount({ label: "Seasonal prices · Alpine Suite Offer 1", value: "2 seasons" });
  const summary = view.root.findByType("summary");
  expect(summary.props["aria-label"]).toBe("Seasonal prices · Alpine Suite Offer 1: 2 seasons");
  expect(text(summary)).toBe("Seasonal prices2 seasons");
  // Closed by default, yet a half-entered field stays mounted.
  expect(view.root.findByType("details").props.open).toBeUndefined();
  expect(
    view.root.findByProps({ "aria-label": "Season name for Alpine Suite Offer 1" }),
  ).toBeDefined();
});

it("names the row by its title alone when no label is given", () => {
  mount({});
  expect(view.root.findByType("summary").props["aria-label"]).toBeUndefined();
  expect(JSON.stringify(view.toJSON())).toContain("Seasonal prices");
});
