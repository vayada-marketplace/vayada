/** @vitest-environment jsdom */
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ExtrasBar from "./ExtrasBar";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const labels = {
  backToRooms: "Back to rooms",
  yourExtras: (count: number) => `Your extras (${count})`,
  yourExtrasTitle: "Your extras",
  extrasTotal: "Extras total",
  toSchedule: (count: number) => `${count} to schedule`,
  showExtras: "Show your extras",
  close: "Close your extras",
  removeExtra: (name: string) => `Remove ${name} from your extras`,
};
const render = (props: Partial<ComponentProps<typeof ExtrasBar>> = {}) =>
  act(() =>
    root.render(
      createElement(ExtrasBar, {
        rows: [],
        extrasTotal: null,
        stay: { line: "Garden room · Flexible · 2 nights", total: "€410 total" },
        continueLabel: "Continue without extras",
        onContinue: () => undefined,
        continueDisabled: false,
        waiting: false,
        hint: null,
        onBack: () => undefined,
        labels,
        ...props,
      }),
    ),
  );
const button = (name: string) =>
  Array.from(host.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label")?.startsWith(name) || b.textContent === name,
  )!;

it("shows no extras chip until an extra is added, and the stay's line and total (VAY-2391)", () => {
  const onBack = vi.fn();
  const onContinue = vi.fn();
  render({ onBack, onContinue });
  expect(host.textContent).toContain("Garden room · Flexible · 2 nights");
  expect(host.textContent).toContain("€410 total");
  expect(host.textContent).not.toContain("Your extras");
  act(() => button("Back to rooms").click());
  act(() => button("Continue without extras").click());
  expect(onBack).toHaveBeenCalledOnce();
  expect(onContinue).toHaveBeenCalledOnce();
});

it("lists the chosen extras by date with their total, and marks one still to schedule", () => {
  const remove = vi.fn();
  render({
    continueLabel: "Continue to your details",
    extrasTotal: "€210",
    waiting: true,
    hint: "Choose a day for Sunset dinner, or remove it.",
    rows: [
      {
        id: "transfer",
        name: "Airport transfer",
        badge: { top: "3", bottom: "Nov" },
        sub: "On arrival",
        price: "€30",
        needsDay: false,
        onRemove: remove,
      },
      {
        id: "dinner",
        name: "Sunset dinner",
        badge: { top: "?", bottom: "Day" },
        sub: "Choose a day",
        price: null,
        needsDay: true,
        onRemove: () => undefined,
      },
    ],
  });
  expect(host.textContent).toContain("Your extras (2)");
  expect(host.textContent).toContain("1 to schedule");
  expect(host.querySelector('[role="alert"]')!.textContent).toBe(
    "Choose a day for Sunset dinner, or remove it.",
  );
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  act(() => button("Show your extras").click());
  const list = host.querySelector('[role="dialog"]')!;
  expect(list.getAttribute("aria-label")).toBe("Your extras");
  expect(Array.from(list.querySelectorAll("li")).map((row) => row.textContent)).toEqual([
    "3NovAirport transferOn arrival€30",
    "?DaySunset dinnerChoose a day",
  ]);
  expect(list.textContent).toContain("Extras total€210");
  act(() => button("Remove Airport transfer").click());
  expect(remove).toHaveBeenCalledOnce();
  // Escape closes the list.
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

it("closes the list with its last extra, so a later extra doesn't open it again", () => {
  const row = {
    id: "transfer",
    name: "Airport transfer",
    badge: { top: "3", bottom: "Nov" },
    sub: "On arrival",
    price: null,
    needsDay: false,
    onRemove: () => undefined,
  };
  render({ rows: [row] });
  act(() => button("Show your extras").click());
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  render({ rows: [] });
  render({ rows: [row] });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});
