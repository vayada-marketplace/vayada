import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  oldLoad: vi.fn(),
  facts: vi.fn(),
  forget: vi.fn(),
}));
vi.mock("@/lib/settings/useGuestStayTimes", () => ({ forgetGuestStayTimes: api.forget }));
vi.mock("@/services/settings/guestRules", () => ({
  guestRulesService: { load: api.load, save: api.save },
  guestRulesRefusal: (cause: { data?: { code?: string } }) => cause?.data?.code ?? null,
}));
vi.mock("@/services/settings/arrivalTimes", () => ({ arrivalTimesService: { load: api.oldLoad } }));
vi.mock("@/services/api/pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: async () => "property-1",
  getPmsPropertyFacts: api.facts,
  // localizedErrorText checks errors against it.
  PmsPropertySelectionRequiredError: class extends Error {},
}));
import { ArrivalTimesSection } from "./ArrivalTimesSection";

const REVISION = "6d1c3a52-5b5e-4c3f-9a51-1f3f8d1b2c4e";
const NEXT_REVISION = "7e2d4b63-6c6f-4d4a-8b62-2a4a9e2c3d5f";
const choices = {
  defaultGuestLanguage: "de",
  childrenEnabled: false,
  adultAgeThreshold: null,
  phoneRequired: true,
  arrivalTimeEnabled: false,
  specialRequestsEnabled: true,
  checkInTime: "15:00",
  checkOutTime: "11:00",
};

async function render() {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(ArrivalTimesSection));
  });
  return view;
}
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const text = (view: ReactTestRenderer) => textOf(view.root);
const button = (view: ReactTestRenderer, label: string) =>
  view.root.find((node) => node.type === "button" && textOf(node) === label);
const click = (view: ReactTestRenderer, label: string) =>
  act(async () => button(view, label).props.onClick());
const times = (view: ReactTestRenderer) => view.root.findAllByProps({ type: "time" });
const setTime = (view: ReactTestRenderer, index: number, value: string) =>
  act(() => times(view)[index]!.props.onChange({ target: { value } }));
const switches = (view: ReactTestRenderer) =>
  view.root.findAll((node) => node.type === "button" && node.props.role === "switch");
const toggle = (view: ReactTestRenderer, index: number) =>
  act(() => switches(view)[index]!.props.onClick());
const status = (view: ReactTestRenderer) => textOf(view.root.findByProps({ role: "status" }));

describe("Check-in & check-out settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.load.mockResolvedValue({ revision: REVISION, choices });
    api.save.mockResolvedValue(NEXT_REVISION);
    api.oldLoad.mockRejectedValue(new Error("not needed"));
    api.facts.mockResolvedValue({ name: "Villa", city: "Ubud", timeZone: "Asia/Makassar" });
  });

  it("saves the reviewed guest rules over the loaded revision, keeping unrelated choices", async () => {
    const view = await render();
    expect(api.load).toHaveBeenCalledWith(expect.any(AbortSignal), "property-1");
    expect(api.oldLoad).not.toHaveBeenCalled();
    expect(text(view)).toContain("Central Indonesia Time (UTC+8)");
    expect(text(view)).not.toContain("Confirm your guest policy");
    expect(status(view)).toBe("All changes saved");
    expect(button(view, "Review & save").props.disabled).toBe(true);
    expect(button(view, "Discard changes").props.disabled).toBe(true);

    await toggle(view, 0);
    expect(times(view)[1]!.props.value).toBe("22:00");
    await setTime(view, 1, "23:00");
    expect(status(view)).toBe("You have unsaved changes");
    expect(text(view)).toContain(
      "Guests check out by 11:00 and check in between 15:00 and 23:00. That leaves 4 h to turn the room over.",
    );
    await click(view, "Review & save");
    expect(text(view)).toContain("Review guest policy");
    expect(text(view)).toContain("15:00 – 23:00");
    expect(api.save).not.toHaveBeenCalled();
    await click(view, "Confirm & save");
    expect(api.save).toHaveBeenCalledWith(
      "property-1",
      REVISION,
      { ...choices, checkInUntil: "23:00" },
      expect.stringMatching(/^arrival-times:/),
    );
    // The dashboard, the booking and the check-in show the new times next; the save's revision is kept.
    expect(api.forget).toHaveBeenCalledTimes(1);
    expect(api.load).toHaveBeenCalledTimes(1);
    expect(text(view)).not.toContain("Review guest policy");
    expect(status(view)).toBe("Saved. Your booking page updates within a minute.");

    await setTime(view, 0, "16:00");
    await click(view, "Review & save");
    await click(view, "Confirm & save");
    expect(api.save).toHaveBeenLastCalledWith(
      "property-1",
      NEXT_REVISION,
      { ...choices, checkInTime: "16:00", checkInUntil: "23:00" },
      expect.stringMatching(/^arrival-times:/),
    );
  });

  it("keeps the edits when a save is refused, and retries an unanswered one under the same key", async () => {
    const view = await render();
    await act(async () =>
      view.root
        .find(
          (node) =>
            node.type === "button" &&
            node.props["aria-pressed"] !== undefined &&
            textOf(node) === "16:00",
        )
        .props.onClick(),
    );
    expect(times(view)[0]!.props.value).toBe("16:00");
    api.save.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await click(view, "Review & save");
    await click(view, "Confirm & save");
    expect(textOf(view.root.findByProps({ role: "alert" }))).toBe(
      "Check-in and check-out settings could not be saved. Please try again.",
    );
    const firstKey = api.save.mock.calls[0]![3];
    api.save.mockRejectedValueOnce({ data: { code: "guest_choices_stale" } });
    await click(view, "Review & save");
    await click(view, "Confirm & save");
    expect(api.save.mock.calls[1]![3]).toBe(firstKey);
    expect(textOf(view.root.findByProps({ role: "alert" }))).toContain(
      "Another user changed these settings.",
    );
    expect(times(view)[0]!.props.value).toBe("16:00");
    expect(api.forget).not.toHaveBeenCalled();

    await click(view, "Reload saved values");
    expect(api.load).toHaveBeenCalledTimes(2);
    expect(times(view)[0]!.props.value).toBe("15:00");
    await setTime(view, 0, "16:00");
    await click(view, "Review & save");
    await click(view, "Confirm & save");
    // A refusal is final: the next save gets its own key.
    expect(api.save.mock.calls[2]![3]).not.toBe(firstKey);
  });

  it("refuses windows the booking page can't show, but takes midnight as the latest check-in", async () => {
    const view = await render();
    await toggle(view, 1);
    await setTime(view, 2, "12:00");
    expect(textOf(view.root.findByProps({ role: "alert" }))).toBe("Must be earlier than 11:00.");
    expect(status(view)).toBe("Fix the highlighted field to save");
    expect(button(view, "Review & save").props.disabled).toBe(true);
    await setTime(view, 2, "07:00");
    await toggle(view, 0);
    await setTime(view, 1, "00:00");
    expect(view.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(text(view)).toContain("Guests must arrive by midnight.");
    expect(text(view)).toContain("between 15:00 and midnight");
    await click(view, "Review & save");
    await click(view, "Confirm & save");
    expect(api.save).toHaveBeenCalledWith(
      "property-1",
      REVISION,
      { ...choices, checkInUntil: "00:00", checkOutFrom: "07:00" },
      expect.any(String),
    );
  });

  it("starts a property's first guest rules from its earlier PMS policy and confirms them", async () => {
    api.load.mockResolvedValue(null);
    api.oldLoad.mockResolvedValue({
      current: null,
      draft: {
        ...choices,
        defaultGuestLanguage: null,
        childrenEnabled: null,
        adultAgeThreshold: null,
        checkInTime: "14:00",
        checkOutTime: "12:00",
      },
    });
    const view = await render();
    expect(text(view)).toContain("Confirm your guest policy");
    expect(text(view)).toContain("2 of 5 required settings done");
    expect(status(view)).toBe("Choose 3 more required settings to save");
    expect(times(view).map((input) => input.props.value)).toEqual(["14:00", "12:00"]);

    await act(() => view.root.findByType("select").props.onChange({ target: { value: "en" } }));
    await act(() => view.root.findByProps({ type: "radio", value: "no" }).props.onChange());
    // Adults-only: no age to choose.
    expect(view.root.findAllByProps({ type: "number" })).toHaveLength(0);
    expect(text(view)).toContain("4 of 4 required settings done");
    expect(status(view)).toBe("You have unsaved changes");
    await click(view, "Review & save");
    expect(text(view)).not.toContain("Adult age threshold");
    await click(view, "Confirm & save");
    expect(api.save).toHaveBeenCalledWith(
      "property-1",
      null,
      { ...choices, defaultGuestLanguage: "en", checkInTime: "14:00", checkOutTime: "12:00" },
      expect.any(String),
    );
    expect(text(view)).not.toContain("Confirm your guest policy");
  });

  it("asks to confirm a complete earlier PMS policy as it is", async () => {
    api.load.mockResolvedValue(null);
    api.oldLoad.mockResolvedValue({ current: { bundle: { choices } }, draft: null });
    const view = await render();
    expect(text(view)).toContain("4 of 4 required settings done");
    expect(status(view)).toBe("Ready — review and confirm your policy");
    expect(button(view, "Discard changes").props.disabled).toBe(true);
    await click(view, "Review & save");
    await click(view, "Confirm & save");
    expect(api.save).toHaveBeenCalledWith("property-1", null, choices, expect.any(String));
    expect(status(view)).toBe("Saved. Your booking page updates within a minute.");
  });

  it("never saves made-up choices when loading fails or nothing was chosen before", async () => {
    api.load.mockRejectedValueOnce(new Error("offline"));
    api.facts.mockRejectedValue(new Error("no access to the property profile"));
    const view = await render();
    expect(view.root.findAllByProps({ type: "time" })).toHaveLength(0);
    expect(view.root.findAllByProps({ role: "alert" })).not.toHaveLength(0);
    api.load.mockResolvedValueOnce(null);
    await click(view, "Retry");
    expect(times(view).map((input) => input.props.value)).toEqual(["", ""]);
    expect(text(view)).toContain("0 of 5 required settings done");
    expect(status(view)).toBe("Choose 5 more required settings to save");
    expect(button(view, "Review & save").props.disabled).toBe(true);
    // Without a time zone, no pill.
    expect(text(view)).not.toContain("UTC");
    expect(api.save).not.toHaveBeenCalled();
  });
});
