import React from "react";
import { create } from "react-test-renderer";
import { expect, it } from "vitest";
import AccountAdminCard from "./AccountAdminCard";

const admin = {
  membershipId: "admin",
  name: "Actual Owner",
  email: "owner@example.invalid",
  roleKey: "hotel_owner",
  active: true,
};
it("shows the actual owner and flags missing, legacy, multiple or suspended admins", () => {
  const view = create(<AccountAdminCard admins={[admin]} />);
  expect(JSON.stringify(view.toJSON())).toContain("Actual Owner");
  expect(view.root.findAll((node) => node.props.role === "status")).toHaveLength(0);
  for (const admins of [
    [],
    [{ ...admin, active: false }],
    [{ ...admin, roleKey: "owner" }],
    [admin, { ...admin, membershipId: "second" }],
  ]) {
    view.update(<AccountAdminCard admins={admins} />);
    expect(view.root.findAll((node) => node.props.role === "status")).toHaveLength(1);
  }
  view.unmount();
});
