import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { RoomImportPreview } from "@vayada/product-onboarding/RoomImportPreview";
import { RoomImportStart, roomImportPatch, parseChannexSnapshot } from "./RoomImportStart";

describe("room import preview", () => {
  it("accepts only supported snapshot facts and labels uploaded provenance", () => {
    const snapshot = parseChannexSnapshot(
      JSON.stringify({
        name: "Villa",
        description: "Description",
        maxGuests: 2,
        checkedAt: "2026-09-09T12:00:00Z",
        sourceLabel: "Verified trusted data",
        currency: "USD",
        baseRate: 100,
      }),
    );
    expect(snapshot).toEqual({
      name: "Villa",
      description: "Description",
      maxGuests: 2,
      sourceLabel: expect.stringContaining("Uploaded Channex snapshot"),
    });
    expect(snapshot.sourceLabel).not.toContain("Verified trusted data");
  });
  it.each([
    "{}",
    "null",
    "[]",
    "invalid",
    "x".repeat(16385),
    JSON.stringify({ name: "Villa", description: "Text", maxGuests: 0, checkedAt: "bad" }),
  ])("rejects unusable snapshots", (input) => {
    expect(() => parseChannexSnapshot(input)).toThrow();
  });
  it("cancels without applying and starts manually without a patch", () => {
    const apply = vi.fn();
    const view = create(<RoomImportStart onContinue={apply} />);
    act(() => view.root.findAllByType("button")[0].props.onClick());
    expect(apply).not.toHaveBeenCalled();
    act(() => view.root.findAllByType("button")[1].props.onClick());
    expect(apply).not.toHaveBeenCalled();
    act(() => view.root.findAllByType("button")[1].props.onClick());
    expect(apply).toHaveBeenCalledWith({});
  });
  it("copies only selected edits and resets review after edits", () => {
    const apply = vi.fn();
    const view = create(
      <RoomImportPreview
        candidate={{
          sourceLabel: "Example",
          name: "Suite",
          description: "Example description",
          maxGuests: 3,
        }}
        onApply={apply}
        onCancel={() => {}}
      />,
    );
    const inputs = () => view.root.findAllByType("input");
    const boxes = () => inputs().filter((input) => input.props.type === "checkbox");
    act(() => boxes()[1].props.onChange({ target: { checked: false } }));
    act(() => boxes()[3].props.onChange({ target: { checked: true } }));
    act(() =>
      inputs()
        .find((input) => input.props.id === "import-name")!
        .props.onChange({ target: { value: "Edited suite" } }),
    );
    expect(view.root.findAllByType("button")[0].props.disabled).toBe(true);
    act(() => boxes()[3].props.onChange({ target: { checked: true } }));
    act(() => view.root.findAllByType("button")[0].props.onClick());
    expect(apply).toHaveBeenCalledWith({ name: "Edited suite", maxGuests: 3 });
  });
  it("rejects an invalid selected guest count", () => {
    const apply = vi.fn();
    const view = create(
      <RoomImportPreview
        candidate={{ sourceLabel: "Example", name: "Suite", description: "Text", maxGuests: 0 }}
        onApply={apply}
        onCancel={() => {}}
      />,
    );
    act(() => view.root.findAllByType("button")[0].props.onClick());
    expect(apply).not.toHaveBeenCalled();
    expect(view.root.findByProps({ role: "alert" })).toBeTruthy();
  });
  it("preserves unrelated form data and ignores extra runtime fields", () => {
    const current = {
      name: "",
      currency: "EUR",
      baseRate: 120,
      totalRooms: 2,
      amenities: ["Wi-Fi"],
      images: [],
    };
    const result = {
      ...current,
      ...roomImportPatch({ name: "Suite", maxGuests: 3, currency: "USD", baseRate: 261 } as never),
    };
    expect(result).toEqual({ ...current, name: "Suite", maxOccupancy: 3 });
  });
});
