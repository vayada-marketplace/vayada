import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import RoomTypeForm, { RoomTabBar } from "./RoomTypeForm";

vi.mock("@/lib/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/components/ImageUpload", () => ({ default: () => null }));

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
  expect(tabs()).toEqual(["rooms.form.tabDetails", "rooms.form.tabMedia"]);
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
  expect(tabs()).toEqual(["rooms.form.tabDetails", "rooms.form.tabPricing", "rooms.form.tabMedia"]);
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
