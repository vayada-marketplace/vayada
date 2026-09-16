import React from "react";
import { create } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import SectionAccessEditor from "./SectionAccessEditor";

it("keeps Team authority editable when PMS is off while disabling operational rows", () => {
  const view = create(
    <SectionAccessEditor
      permissions={["identity.staff.manage"]}
      allowedPermissions={["identity.staff.manage", "pms.calendar.read"]}
      onChange={vi.fn()}
      productAccess={{ pms: false, booking: true }}
    />,
  );
  const fieldsets = view.root.findAllByType("fieldset");
  const groupFor = (name: string) =>
    fieldsets.find(
      (field) =>
        field.findAll(
          (node) =>
            node.type === "div" &&
            node.props.role === "radiogroup" &&
            node.findAllByType("input").some((input) => input.props.name.includes(name)),
        ).length && field.findAllByType("legend").length === 0,
    )!;
  expect(groupFor("-calendar").props.disabled).toBe(true);
  expect(groupFor("-team").props.disabled).toBe(false);
  view.unmount();
});

it("does not label narrow room-status access as No access", () => {
  const view = create(
    <SectionAccessEditor
      permissions={["pms.room_status.read"]}
      allowedPermissions={["pms.room_status.read"]}
      onChange={vi.fn()}
    />,
  );
  const radios = view.root
    .findAllByType("input")
    .filter((input) => input.props.name?.includes("-roomsRates"));
  expect(radios.every((input) => input.props.checked === false)).toBe(true);
  expect(
    view.root
      .findAllByType("input")
      .find((input) => input.props.type === "checkbox" && input.props.checked),
  ).toBeDefined();
  view.unmount();
});
