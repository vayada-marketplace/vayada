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
      properties={[
        { id: "one", name: "One" },
        { id: "two", name: "Two" },
      ]}
    />,
  );
  const row = view.root.findAllByType("tbody")[0]!.findAllByType("tr")[0]!;
  expect(row.findAllByType("span")[0]!.children.join("")).toBe("Account owner");
  expect(row.findAllByType("td").map((cell) => cell.children.join(""))).toEqual([
    "Assigned",
    "Assigned",
  ]);
  view.unmount();
});
