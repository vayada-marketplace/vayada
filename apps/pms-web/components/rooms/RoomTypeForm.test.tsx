import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import RoomTypeForm from "./RoomTypeForm";

vi.mock("@/lib/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("@/components/ImageUpload", () => ({ default: () => null }));

let view: ReactTestRenderer;
afterEach(() => act(() => view?.unmount()));
function Prices() {
  return null;
}
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
const prices = () => view.root.findAllByType(Prices);

it("offers no Prices tab and keeps the pointer where the room has no prices section", async () => {
  await mount({ mode: "create" });
  expect(tabs()).toEqual(["rooms.form.tabDetails", "rooms.form.tabMedia"]);
  expect(JSON.stringify(view.toJSON())).toContain("rooms.form.pricingPointer");
});
it("opens the Prices tab outside the room form, hides the form's save there and keeps unsaved prices when switching tabs (VAY-2093)", async () => {
  await mount({ prices: createElement(Prices), initialTab: "prices" });
  expect(tabs()).toEqual(["rooms.form.tabDetails", "rooms.form.tabPricing", "rooms.form.tabMedia"]);
  expect(JSON.stringify(view.toJSON())).not.toContain("rooms.form.pricingPointer");
  expect(prices()).toHaveLength(1);
  expect(prices()[0].parent!.props.hidden).toBe(false);
  expect(submit()).toHaveLength(0);
  expect(view.root.findByType("form").findAllByType(Prices)).toHaveLength(0);
  await act(async () =>
    view.root
      .findAllByType("button")
      .find((node) => node.children[0] === "rooms.form.tabDetails")!
      .props.onClick(),
  );
  expect(prices()).toHaveLength(1);
  expect(prices()[0].parent!.props.hidden).toBe(true);
  expect(submit()).toHaveLength(1);
});
it("mounts the Prices tab only once it is opened", async () => {
  await mount({ prices: createElement(Prices) });
  expect(prices()).toHaveLength(0);
  expect(submit()).toHaveLength(1);
  await act(async () =>
    view.root
      .findAllByType("button")
      .find((node) => node.children[0] === "rooms.form.tabPricing")!
      .props.onClick(),
  );
  expect(prices()).toHaveLength(1);
  expect(submit()).toHaveLength(0);
});
