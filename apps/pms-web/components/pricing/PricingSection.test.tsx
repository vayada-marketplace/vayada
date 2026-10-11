import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PricingSection } from "./PricingSection";

type Props = { label?: string; value?: string; keepOpen?: boolean };
let view: ReactTestRenderer;
// The rendered <details> as the browser holds it, so the test sees what the row's effect sets.
let details: { open: boolean };
beforeEach(() => {
  vi.stubGlobal("React", React);
  details = { open: false };
});
afterEach(() => {
  act(() => view.unmount());
  vi.unstubAllGlobals();
});
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
const row = (props: Props) => (
  <PricingSection title="Meal plan" {...props}>
    <input aria-label="Meal plan for Alpine Suite Offer 1" />
  </PricingSection>
);
const mount = (props: Props) => {
  act(() => {
    view = create(row(props), { createNodeMock: () => details });
  });
};
const rerender = (props: Props) => act(() => view.update(row(props)));

it("shows a short title, keeps room and offer for screen readers, and keeps closed content mounted (VAY-2122)", () => {
  mount({ label: "Meal plan · Alpine Suite Offer 1: breakfast.", value: "breakfast" });
  const summary = view.root.findByType("summary");
  expect(summary.props["aria-label"]).toBe("Meal plan · Alpine Suite Offer 1: breakfast.");
  expect(text(summary)).toBe("Meal planbreakfast");
  // Closed by default, yet a half-entered field stays mounted.
  expect(details.open).toBe(false);
  expect(
    view.root.findByProps({ "aria-label": "Meal plan for Alpine Suite Offer 1" }),
  ).toBeDefined();
});

it("names the row by its title alone when no label is given", () => {
  mount({});
  expect(view.root.findByType("summary").props["aria-label"]).toBeUndefined();
  expect(JSON.stringify(view.toJSON())).toContain("Meal plan");
});

it("opens a row with an unsaved edit and keeps it open until the edit ends", () => {
  const toggle = () => {
    const event = { preventDefault: vi.fn() };
    view.root.findByType("summary").props.onClick(event);
    return event.preventDefault;
  };
  mount({});
  expect(toggle()).not.toHaveBeenCalled();
  rerender({ keepOpen: true });
  expect(details.open).toBe(true);
  expect(toggle()).toHaveBeenCalledOnce();
  // Once the edit is applied or cancelled the row can close again; it is not closed for the user.
  rerender({ keepOpen: false });
  expect(details.open).toBe(true);
  expect(toggle()).not.toHaveBeenCalled();
});
