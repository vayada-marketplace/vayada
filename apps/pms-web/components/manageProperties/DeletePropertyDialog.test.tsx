import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { HotelPropertyDeletionCheck } from "@vayada/domain-hotels";
import { beforeEach, expect, it, vi } from "vitest";

import { ApiErrorResponse } from "@/services/api/client";

const api = vi.hoisted(() => ({ check: vi.fn(), remove: vi.fn() }));
vi.mock("@/services/api/propertyDeletionClient", async (original) => ({
  ...(await original<object>()),
  getPropertyDeletionCheck: api.check,
  deleteProperty: api.remove,
}));
vi.mock("@/components/Modal", () => ({
  default: ({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));

import DeletePropertyDialog, { deletionNameMatches } from "./DeletePropertyDialog";

// VAY-2493: the two confirmation steps of Manage Properties › Delete.
const propertyId = "20000000-0000-4000-8000-00000000000a";
const deletable: HotelPropertyDeletionCheck = {
  contractVersion: "hotel-property-deletion.v1",
  propertyId,
  displayName: "Escape Villa",
  lifecycleRevision: 3,
  accountProperties: 2,
  blockers: [],
  canDelete: true,
};
const blocked: HotelPropertyDeletionCheck = {
  ...deletable,
  blockers: [
    { code: "upcoming_bookings", count: 2 },
    { code: "connected_channels", count: 1 },
  ],
  canDelete: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.check.mockResolvedValue(deletable);
  api.remove.mockResolvedValue({
    contractVersion: "hotel-property-deletion.v1",
    propertyId,
    deleted: true,
  });
});

it("matches only the exact property name, ignoring spaces at either end", () => {
  expect(deletionNameMatches("Escape Villa", "Escape Villa")).toBe(true);
  expect(deletionNameMatches("  Escape Villa ", "Escape Villa")).toBe(true);
  expect(deletionNameMatches("escape villa", "Escape Villa")).toBe(false);
  expect(deletionNameMatches("Escape", "Escape Villa")).toBe(false);
  expect(deletionNameMatches("", " ")).toBe(false);
});

it("lists what blocks the delete and keeps step 1 closed", async () => {
  api.check.mockResolvedValue(blocked);
  const { view } = await render();

  expect(text(view)).toContain("Delete Escape Villa?");
  expect(text(view)).toContain("You can't delete this property yet:");
  expect(text(view)).toContain("It has 2 upcoming or current bookings. Cancel or move them first.");
  expect(text(view)).toContain("It's connected to a channel manager (Booking.com, Airbnb…).");
  expect(button(view, "Delete property").props.disabled).toBe(true);
  view.unmount();
});

it("needs the exact name in step 2, then deletes with the revision and one request key", async () => {
  const { view, onDeleted } = await render();
  expect(button(view, "Delete property").props.disabled).toBe(false);

  await act(async () => button(view, "Delete property").props.onClick());
  expect(text(view)).toContain("To confirm, type the property name:");
  expect(button(view, "Confirm deletion").props.disabled).toBe(true);

  await type(view, "escape villa");
  expect(button(view, "Confirm deletion").props.disabled).toBe(true);
  await type(view, "Escape Villa");
  expect(button(view, "Confirm deletion").props.disabled).toBe(false);

  await act(async () => button(view, "Confirm deletion").props.onClick());
  expect(api.remove).toHaveBeenCalledWith({
    propertyId,
    expectedLifecycleRevision: 3,
    confirmationName: "Escape Villa",
    idempotencyKey: expect.stringMatching(/^property-delete-/),
  });
  expect(onDeleted).toHaveBeenCalledWith(deletable);
  view.unmount();
});

it("goes back to step 1 with the new blockers when the delete became blocked", async () => {
  api.remove.mockRejectedValue(
    new ApiErrorResponse(409, { code: "deletion_blocked", check: blocked } as never),
  );
  const { view, onDeleted } = await render();
  await act(async () => button(view, "Delete property").props.onClick());
  await type(view, "Escape Villa");
  await act(async () => button(view, "Confirm deletion").props.onClick());

  expect(onDeleted).not.toHaveBeenCalled();
  expect(text(view)).toContain("You can't delete this property yet:");
  expect(button(view, "Delete property").props.disabled).toBe(true);
  view.unmount();
});

it("keeps step 2 open with a message when the delete fails", async () => {
  api.remove.mockRejectedValue(
    new ApiErrorResponse(503, { code: "property_busy", detail: "busy" }),
  );
  const { view, onDeleted } = await render();
  await act(async () => button(view, "Delete property").props.onClick());
  await type(view, "Escape Villa");
  await act(async () => button(view, "Confirm deletion").props.onClick());

  expect(onDeleted).not.toHaveBeenCalled();
  expect(text(view)).toContain("Couldn't delete the property. Try again.");
  expect(button(view, "Confirm deletion").props.disabled).toBe(false);
  view.unmount();
});

async function render() {
  const onDeleted = vi.fn();
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      <DeletePropertyDialog
        property={{ id: propertyId, name: "Escape Villa" }}
        onClose={vi.fn()}
        onDeleted={onDeleted}
      />,
    );
  });
  return { view, onDeleted };
}

async function type(view: ReactTestRenderer, value: string) {
  await act(async () => view.root.findByType("input").props.onChange({ target: { value } }));
}

function button(view: ReactTestRenderer, label: string) {
  return view.root
    .findAllByType("button")
    .find((candidate) => candidate.children.join("") === label)!;
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
