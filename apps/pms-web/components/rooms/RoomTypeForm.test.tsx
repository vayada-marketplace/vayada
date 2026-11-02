import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import RoomLocationField from "@/components/rooms/RoomLocationField";
import RoomTypeForm, { RoomTabBar } from "./RoomTypeForm";

vi.mock("@/lib/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/components/ImageUpload", () => ({ default: () => null }));
vi.mock("@/components/rooms/RoomLocationField", () => ({
  default: function RoomLocationField() {
    return null;
  },
}));

let view: ReactTestRenderer;
afterEach(() => act(() => view?.unmount()));
async function mount(props: Partial<Parameters<typeof RoomTypeForm>[0]> = {}) {
  await act(async () => {
    view = create(
      createElement(RoomTypeForm, {
        form: { name: "Suite", totalRooms: 2 },
        onChange: () => undefined,
        onSubmit: () => undefined,
        saving: false,
        propertyPlan: null,
        mode: "edit",
        ...props,
      }),
    );
  });
}
const tabs = () =>
  view.root
    .findAllByType("button")
    .filter((node) => String(node.props.className).includes("pb-2.5"))
    .map((node) => node.children[0]);
const submit = () => view.root.findAllByProps({ type: "submit" });

it("offers no Prices tab where the page does not own the tab", async () => {
  await mount({ mode: "create" });
  expect(tabs()).toEqual([
    "rooms.form.tabDetails",
    "rooms.form.tabMedia",
    "rooms.form.tabLocation",
  ]);
  await act(async () =>
    view.root
      .findAllByType("button")
      .find((node) => node.children[0] === "rooms.form.tabMedia")!
      .props.onClick(),
  );
  expect(submit()).toHaveLength(1);
});

it("lets the page own the tab: the Prices tab hides this form's save and leaves its content to the page (VAY-2093)", async () => {
  const onTabChange = vi.fn();
  await mount({ tab: "prices", onTabChange });
  // The page draws the tab bar, with its messages under it (VAY-2337).
  expect(tabs()).toEqual([]);
  expect(submit()).toHaveLength(0);
  expect(JSON.stringify(view.toJSON())).not.toContain("rooms.form.roomTypeBasics");
  act(() =>
    view.update(
      createElement(RoomTypeForm, {
        form: { name: "Suite", totalRooms: 2 },
        onChange: () => undefined,
        onSubmit: () => undefined,
        saving: false,
        propertyPlan: null,
        mode: "edit",
        tab: "details",
        onTabChange,
      }),
    ),
  );
  expect(submit()).toHaveLength(1);
  expect(JSON.stringify(view.toJSON())).toContain("rooms.form.roomTypeBasics");
});

it("draws the room tabs for the page, and the form's own messages come after its tab bar (VAY-2337)", async () => {
  const onTabChange = vi.fn();
  await act(async () => {
    view = create(createElement(RoomTabBar, { tab: "prices", onTabChange }));
  });
  expect(tabs()).toEqual([
    "rooms.form.tabDetails",
    "rooms.form.tabPricing",
    "rooms.form.tabMedia",
    "rooms.form.tabLocation",
  ]);
  await act(async () =>
    view.root
      .findAllByType("button")
      .find((node) => node.children[0] === "rooms.form.tabDetails")!
      .props.onClick(),
  );
  expect(onTabChange).toHaveBeenCalledWith("details");

  await mount({ error: "Save failed", success: "Saved" });
  const text = JSON.stringify(view.toJSON());
  for (const message of ["Save failed", "Saved"])
    expect(text.indexOf(message)).toBeGreaterThan(text.indexOf("rooms.form.tabMedia"));
});

it("keeps the room's place on its own Location tab, saved by the form's one Save (VAY-2452)", async () => {
  const onChange = vi.fn();
  const props = {
    form: { name: "Suite", totalRooms: 2, locationAddress: "Leopoldstraße 12", latitude: 48.15 },
    onChange,
    onSubmit: () => undefined,
    saving: false,
    propertyPlan: null,
    mode: "edit" as const,
    roomTypeId: "room-1",
    onTabChange: vi.fn(),
  };
  await mount({ ...props, tab: "details" });
  // Room Details ends with the category tag: the place is not on it.
  expect(view.root.findAllByType(RoomLocationField)).toHaveLength(0);
  expect(JSON.stringify(view.toJSON())).toContain("rooms.form.roomCategoryTag");

  act(() => view.update(createElement(RoomTypeForm, { ...props, tab: "location" })));
  const field = view.root.findByType(RoomLocationField);
  expect(field.props).toMatchObject({
    roomId: "room-1",
    roomName: "Suite",
    value: { locationAddress: "Leopoldstraße 12", latitude: 48.15, longitude: null },
  });
  expect(JSON.stringify(view.toJSON())).not.toContain("rooms.form.roomTypeBasics");
  expect(submit()).toHaveLength(1);

  // An edit lands on the form as it is then, next to edits from the other tabs.
  act(() => field.props.onChange({ showMapInDetails: false }));
  const update = onChange.mock.calls.at(-1)![0] as (prev: object) => object;
  expect(update({ name: "Lake Suite", amenities: ["Safe"] })).toEqual({
    name: "Lake Suite",
    amenities: ["Safe"],
    showMapInDetails: false,
  });
  // Save waits while the place holds something it would lose.
  act(() => field.props.onValidityChange(false));
  expect(submit()[0].props.disabled).toBe(true);
  act(() => field.props.onValidityChange(true));
  expect(submit()[0].props.disabled).toBe(false);

  // Back on the tab after an unsaved choice, the field still learns the room's saved one (none here).
  expect(field.props.savedSource).toBeUndefined();
  const chosen = { ...props.form, locationSource: "custom" as const };
  act(() => view.update(createElement(RoomTypeForm, { ...props, form: chosen, tab: "details" })));
  act(() => view.update(createElement(RoomTypeForm, { ...props, form: chosen, tab: "location" })));
  expect(view.root.findByType(RoomLocationField).props).toMatchObject({
    value: { locationSource: "custom" },
    savedSource: undefined,
  });
});

it("shows the page's note beside the buttons and its text while saving (VAY-2147)", async () => {
  await mount({
    mode: "create",
    submitLabel: "Create",
    actionNote: "Creating declares the prices.",
  });
  expect(JSON.stringify(view.toJSON())).toContain("Creating declares the prices.");
  expect(submit()[0].children).toEqual(["Create"]);
  await mount({ mode: "create", saving: true, savingLabel: "Saving prices…" });
  expect(submit()[0].children).toEqual(["Saving prices…"]);
  expect(submit()[0].props.disabled).toBe(true);
});
