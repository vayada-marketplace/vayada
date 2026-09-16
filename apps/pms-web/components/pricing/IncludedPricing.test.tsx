import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { includedPrice, IncludedPricing } from "./IncludedPricing";
const fixed = { adults: "2", adjustments: [{ kind: "fixed", value: "-30" }, { kind: "", value: "" }, { kind: "fixed", value: "+25" }] };
afterEach(() => vi.unstubAllGlobals());
it("builds a complete base-relative table and accepts exact signed percentages", () => {
  expect(includedPrice(fixed, "130", 3, 2)).toEqual({ mode: "included_guests", baseGuests: 2, baseMinor: "13000", adjustments: [
    { kind: "fixed", deltaMinor: "-3000" }, { kind: "fixed", deltaMinor: "0" }, { kind: "fixed", deltaMinor: "2500" }] });
  expect(includedPrice({ adults: "1", adjustments: [fixed.adjustments[0], { kind: "percentage", value: "+12.25" }] }, "10.123", 2, 3)).toMatchObject({ baseMinor: "10123", adjustments: [{ deltaMinor: "0" }, { basisPoints: 1225 }] });
  expect(includedPrice({ adults: "1", adjustments: [] }, "100", 1, 0).adjustments).toEqual([{ kind: "fixed", deltaMinor: "0" }]);
});
it("rejects missing rows, invalid counts, nonpositive rounded prices and overflow", () => {
  for (const adults of ["", "0", "4", "1.5"]) expect(() => includedPrice({ ...fixed, adults }, "130", 3, 2)).toThrow();
  for (const row of [{ kind: "", value: "0" }, { kind: "fixed", value: "" }, { kind: "fixed", value: "-130" }, { kind: "fixed", value: "-131" },
    { kind: "fixed", value: "1.001" }, { kind: "percentage", value: "-100" }, { kind: "percentage", value: "12.345" }, { kind: "fixed", value: "1e3" }])
    expect(() => includedPrice({ ...fixed, adjustments: [row] }, "130", 3, 2)).toThrow();
  expect(() => includedPrice({ adults: "1", adjustments: [{ kind: "fixed", value: "0" }, { kind: "percentage", value: "-99.99" }] }, "0.01", 2, 2)).toThrow("positive");
  expect(() => includedPrice({ adults: "1", adjustments: [{ kind: "fixed", value: "0" }, { kind: "fixed", value: "1" }] }, "999999999999999999", 2, 0)).toThrow("range");
  expect(includedPrice({ ...fixed, adjustments: [{ kind: "fixed", value: "-0" }, ...fixed.adjustments.slice(1)] }, "130", 3, 2).adjustments[0]).toEqual({ kind: "fixed", deltaMinor: "0" });
});
it("clears adjustments when base count changes and clears values when adjustment units change", async () => {
  vi.stubGlobal("React", React); const onChange = vi.fn(); let view!: ReactTestRenderer;
  const props = { value: fixed, capacity: 3, disabled: false, onChange };
  await act(async () => { view = create(<IncludedPricing {...props} />); });
  await act(async () => view.root.findByProps({ "aria-label": "Adults included in the base price" }).props.onChange({ target: { value: "1" } }));
  expect(onChange).toHaveBeenLastCalledWith({ adults: "1", adjustments: [] });
  await act(async () => view.root.findByProps({ "aria-label": "Adjustment type for 1 adult" }).props.onChange({ target: { value: "percentage" } }));
  expect(onChange.mock.lastCall![0].adjustments[0]).toEqual({ kind: "percentage", value: "" });
  await act(async () => view.update(<IncludedPricing {...props} disabled />));
  expect(view.root.findAll((node) => ["input", "select"].includes(String(node.type))).every((node) => node.props.disabled)).toBe(true);
  act(() => view.unmount());
});
