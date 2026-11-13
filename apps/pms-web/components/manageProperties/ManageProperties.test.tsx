import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { PmsAccessProvider } from "@/lib/settings/PmsAccessContext";

const api = vi.hoisted(() => ({ list: vi.fn(), stored: vi.fn(), store: vi.fn() }));
vi.mock("@/services/api/pmsPropertyClient", () => ({
  listPmsProperties: api.list,
  getStoredPmsPropertyId: api.stored,
  storeSelectedPmsPropertyId: api.store,
}));
// The dialog has its own tests; here it reports a finished delete straight away.
vi.mock("./DeletePropertyDialog", () => ({
  default: ({
    property,
    onDeleted,
  }: {
    property: { id: string; name: string };
    onDeleted: (check: { propertyId: string; displayName: string }) => void;
  }) => (
    <button
      type="button"
      data-testid="finish-delete"
      onClick={() => onDeleted({ propertyId: property.id, displayName: property.name })}
    >
      dialog
    </button>
  ),
}));

import ManageProperties, { DELETED_PROPERTY_NOTICE_KEY } from "./ManageProperties";

// VAY-2493: account menu › Manage Properties.
const escape = {
  id: "p-escape",
  name: "Escape Villa",
  slug: "escape",
  location: "Ubud, ID",
  country: "",
};
const dewari = {
  id: "p-dewari",
  name: "Dewari Villa",
  slug: "dewari",
  location: "Ubud, ID",
  country: "",
};
const session = new Map<string, string>();

beforeEach(() => {
  vi.clearAllMocks();
  session.clear();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => session.set(key, value),
    removeItem: (key: string) => session.delete(key),
  });
  api.list.mockResolvedValue([dewari, escape]);
  api.stored.mockReturnValue(escape.id);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows only a note to members who are not the account admin", async () => {
  const { view } = await render("hotel_manager");

  expect(text(view)).toContain("Only the account admin can manage properties.");
  expect(api.list).not.toHaveBeenCalled();
  expect(deleteButtons(view)).toHaveLength(0);
  view.unmount();
});

it("lists every property with Delete and marks the open one", async () => {
  const { view } = await render();

  expect(deleteButtons(view).map((button) => button.props["aria-label"])).toEqual([
    "Delete Dewari Villa",
    "Delete Escape Villa",
  ]);
  expect(deleteButtons(view).every((button) => button.props.disabled === false)).toBe(true);
  expect(text(view)).toContain("Current");
  view.unmount();
});

it("can't delete the account's last property", async () => {
  api.list.mockResolvedValue([escape]);
  const { view } = await render();

  expect(deleteButtons(view)).toHaveLength(1);
  expect(deleteButtons(view)[0]!.props.disabled).toBe(true);
  expect(text(view)).toContain(
    "An account needs at least one property, so its last property can't be deleted.",
  );
  view.unmount();
});

it("switches to another property and reloads after deleting the open one", async () => {
  const { view, reload } = await render();
  await act(async () => deleteButtons(view)[1]!.props.onClick());
  await act(async () => view.root.findByProps({ "data-testid": "finish-delete" }).props.onClick());

  expect(api.store).toHaveBeenCalledWith(dewari.id);
  expect(session.get(DELETED_PROPERTY_NOTICE_KEY)).toBe("Escape Villa");
  expect(reload).toHaveBeenCalledOnce();
  view.unmount();
});

it("keeps the open property when another one is deleted, and shows the notice once", async () => {
  const { view, reload } = await render();
  await act(async () => deleteButtons(view)[0]!.props.onClick());
  await act(async () => view.root.findByProps({ "data-testid": "finish-delete" }).props.onClick());
  expect(api.store).not.toHaveBeenCalled();
  expect(reload).toHaveBeenCalledOnce();
  view.unmount();

  const reloaded = await render();
  expect(text(reloaded.view)).toContain("Dewari Villa has been deleted.");
  expect(session.has(DELETED_PROPERTY_NOTICE_KEY)).toBe(false);
  reloaded.view.unmount();
});

async function render(roleKey = "hotel_owner") {
  const reload = vi.fn();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      <PmsAccessProvider access={{ membershipId: "m-1", roleKey, permissions: [] }}>
        <ManageProperties reload={reload} />
      </PmsAccessProvider>,
    );
  });
  return { view, reload };
}

function deleteButtons(view: ReactTestRenderer) {
  return view.root
    .findAllByType("button")
    .filter((button) => String(button.props["aria-label"] ?? "").startsWith("Delete "));
}

function text(view: ReactTestRenderer): string {
  const collect = (node: unknown): string =>
    typeof node === "string"
      ? node
      : Array.isArray(node)
        ? node.map(collect).join("")
        : node && typeof node === "object" && "children" in node
          ? collect((node as { children: unknown }).children ?? [])
          : "";
  return collect(view.toJSON());
}
