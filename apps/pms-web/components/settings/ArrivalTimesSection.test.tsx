import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), oldLoad: vi.fn(), forget: vi.fn() }));
vi.mock("@/lib/settings/useGuestStayTimes", () => ({ forgetGuestStayTimes: api.forget }));
vi.mock("@/services/settings/guestRules", () => ({
  guestRulesService: { load: api.load, save: api.save },
  guestRulesSaveError: (cause: { data?: { code?: string } }) => `refused: ${cause.data?.code}`,
}));
vi.mock("@/services/settings/arrivalTimes", () => ({ arrivalTimesService: { load: api.oldLoad } }));
vi.mock("@/services/api/pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: async () => "property-1",
  // localizedErrorText checks errors against it.
  PmsPropertySelectionRequiredError: class extends Error {},
}));
import { ArrivalTimesSection } from "./ArrivalTimesSection";
const REVISION = "6d1c3a52-5b5e-4c3f-9a51-1f3f8d1b2c4e";
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
  let view!: ReturnType<typeof create>;
  await act(async () => {
    view = create(createElement(ArrivalTimesSection));
  });
  return view;
}
const submit = (view: ReturnType<typeof create>) =>
  act(async () => view.root.findByType("form").props.onSubmit({ preventDefault() {} }));
const confirm = (view: ReturnType<typeof create>) =>
  act(() =>
    view.root
      .findAllByProps({ type: "checkbox" })
      .slice(-1)[0]!
      .props.onChange({ target: { checked: true } }),
  );
const text = (view: ReturnType<typeof create>) =>
  view.root
    .findAll((node) => typeof node.type === "string")
    .flatMap((node) => node.children.filter((child) => typeof child === "string"))
    .join(" ");
describe("arrival times editor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.load.mockResolvedValue({ revision: REVISION, choices });
    api.save.mockResolvedValue("7e2d4b63-6c6f-4d4a-8b62-2a4a9e2c3d5f");
    api.oldLoad.mockRejectedValue(new Error("not needed"));
  });
  it("saves the reviewed guest rules over the loaded revision, keeping unrelated choices", async () => {
    const view = await render();
    expect(api.load).toHaveBeenCalledWith(expect.any(AbortSignal), "property-1");
    expect(api.oldLoad).not.toHaveBeenCalled();
    act(() =>
      view.root.findAllByProps({ type: "time" })[1]!.props.onChange({ target: { value: "23:00" } }),
    );
    await submit(view);
    expect(api.save).not.toHaveBeenCalled();
    expect(text(view)).toContain("–23:00");
    await confirm(view);
    await submit(view);
    expect(api.save).toHaveBeenCalledWith(
      "property-1",
      REVISION,
      { ...choices, checkInUntil: "23:00" },
      expect.stringContaining("arrival-times:"),
    );
    // The dashboard, the booking and the check-in show the new times next.
    expect(api.forget).toHaveBeenCalledTimes(1);
    expect(api.load).toHaveBeenCalledTimes(2);
  });
  it("invalidates confirmation on edits and keeps entered times when a save is refused", async () => {
    const view = await render();
    await submit(view);
    await confirm(view);
    api.save.mockRejectedValueOnce({ data: { code: "guest_choices_stale" } });
    await submit(view);
    expect(view.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "refused: guest_choices_stale",
    );
    act(() =>
      view.root.findAllByProps({ type: "time" })[0]!.props.onChange({ target: { value: "16:00" } }),
    );
    expect(view.root.findAllByProps({ type: "checkbox" })).toHaveLength(0);
    expect(view.root.findAllByProps({ type: "time" })[0]!.props.value).toBe("16:00");
    expect(api.forget).not.toHaveBeenCalled();
  });
  it("refuses arrival windows the booking page can't show before review", async () => {
    const view = await render();
    act(() =>
      view.root.findAllByProps({ type: "time" })[2]!.props.onChange({ target: { value: "12:00" } }),
    );
    await submit(view);
    expect(view.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "Check-out from must be earlier than check-out by",
    );
    expect(view.root.findAllByProps({ type: "checkbox" })).toHaveLength(0);
  });
  it("prefills a property's first guest rules from its earlier PMS policy", async () => {
    api.load.mockResolvedValue(null);
    api.oldLoad.mockResolvedValue({
      current: { bundle: { choices: { ...choices, checkOutTime: "12:00" } } },
    });
    const view = await render();
    expect(view.root.findAllByType("select")).toHaveLength(2);
    expect(view.root.findAllByProps({ type: "time" })[3]!.props.value).toBe("12:00");
    await submit(view);
    await confirm(view);
    await submit(view);
    expect(api.save).toHaveBeenCalledWith(
      "property-1",
      null,
      { ...choices, checkOutTime: "12:00" },
      expect.stringContaining("arrival-times:"),
    );
  });
  it("never saves made-up choices when loading fails or nothing was chosen before", async () => {
    api.load.mockRejectedValueOnce(new Error("offline"));
    const view = await render();
    expect(view.root.findAllByType("form")).toHaveLength(0);
    api.load.mockResolvedValueOnce(null);
    await act(async () => view.root.findByType("button").props.onClick());
    expect(view.root.findAllByProps({ type: "time" }).map((input) => input.props.value)).toEqual([
      "",
      "",
      "",
      "",
    ]);
    await submit(view);
    expect(view.root.findByProps({ role: "alert" }).children.join("")).toContain(
      "Choose a guest language",
    );
    expect(api.save).not.toHaveBeenCalled();
  });
});
