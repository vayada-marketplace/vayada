import React from "react";
import { create } from "react-test-renderer";
import { expect, it } from "vitest";
import PropertyAccessMatrix from "./PropertyAccessMatrix";

it("shows the active account administrator with access to every property", () => {
  const view = create(
    <PropertyAccessMatrix
      admins={[
        {
          membershipId: "owner",
          name: "Account owner",
          email: "owner@example.test",
          roleKey: "hotel_owner",
          active: true,
          revision: "a".repeat(64),
        },
      ]}
      members={[]}
      roleLabel={() => "Front desk"}
      properties={[
        { id: "one", name: "One" },
        { id: "two", name: "Two" },
      ]}
    />,
  );
  const row = view.root.findAllByType("tbody")[0]!.findAllByType("tr")[0]!;
  expect(row.findAllByType("span")[0]!.children.join("")).toBe("Account owner");
  const label = (cell: (typeof row.children)[number]) =>
    typeof cell === "string" ? cell : cell.findByProps({ className: "sr-only" }).children.join("");
  expect(row.findAllByType("td").map(label)).toEqual(["Assigned", "Assigned"]);
  view.unmount();
});

it("ticks every property for a member with access to all properties", () => {
  const view = create(
    <PropertyAccessMatrix
      members={[
        {
          id: "manager",
          name: "Manager",
          email: "manager@example.test",
          roleKey: "hotel_custom",
          propertyAccessMode: "all",
          propertyIds: [],
          status: "active",
          lastActiveAt: null,
        },
      ]}
      roleLabel={() => "Operations lead"}
      properties={[
        { id: "one", name: "One" },
        { id: "two", name: "Two" },
      ]}
    />,
  );
  const row = view.root.findAllByType("tbody")[0]!.findAllByType("tr")[0]!;
  expect(
    row.findAllByType("td").map((cell) => cell.findByProps({ className: "sr-only" }).children),
  ).toEqual([["Assigned"], ["Assigned"]]);
  view.unmount();
});
