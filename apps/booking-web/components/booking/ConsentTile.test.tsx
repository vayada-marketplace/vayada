/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ConsentTile from "./ConsentTile";

const change = vi.fn();
const read = vi.fn();
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
function render(state: { checked?: boolean; disabled?: boolean; errorId?: string } = {}) {
  act(() =>
    root.render(
      createElement(
        ConsentTile,
        {
          label: "I have read our guest rules for this price.",
          checked: false,
          disabled: false,
          onChange: change,
          ...state,
        },
        createElement("button", { type: "button", onClick: read }, "Read our guest rules"),
      ),
    ),
  );
}
const box = () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

it("is a real checkbox named by its sentence, ticked from its label (VAY-2306)", () => {
  render();
  expect(box().closest("label")?.textContent).toBe("I have read our guest rules for this price.");
  act(() => document.querySelector("label")!.click());
  expect(change).toHaveBeenLastCalledWith(true);
  render({ checked: true });
  expect(box().checked).toBe(true);
  act(() => box().click());
  expect(change).toHaveBeenLastCalledWith(false);
});

it("opens Read without ticking", () => {
  render();
  const button = document.querySelector("button")!;
  expect(button.closest("label")).toBeNull();
  act(() => button.click());
  expect(read).toHaveBeenCalledTimes(1);
  expect(change).not.toHaveBeenCalled();
});

it("marks only an unticked, tickable box as missing", () => {
  render({ errorId: "consent-missing" });
  expect(box().getAttribute("aria-invalid")).toBe("true");
  expect(box().getAttribute("aria-describedby")).toBe("consent-missing");
  render({ errorId: "consent-missing", checked: true });
  expect(box().hasAttribute("aria-invalid")).toBe(false);
  expect(box().hasAttribute("aria-describedby")).toBe(false);
  render({ errorId: "consent-missing", disabled: true });
  expect(box().disabled).toBe(true);
  expect(box().hasAttribute("aria-invalid")).toBe(false);
  render();
  expect(box().hasAttribute("aria-invalid")).toBe(false);
});
