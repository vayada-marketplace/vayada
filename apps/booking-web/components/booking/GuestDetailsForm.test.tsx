/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicQuoteGuestDisclosure } from "@vayada/domain-booking/replacement-pricing";
import GuestDetailsForm, {
  acceptanceGuest,
  emptyGuest,
  guestComplete,
  type GuestDetails,
} from "./GuestDetailsForm";

const rules = {
  phoneRequired: true,
  arrivalTimeEnabled: true,
  specialRequestsEnabled: true,
} as PublicQuoteGuestDisclosure["choices"];
const ada: GuestDetails = {
  ...emptyGuest,
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  phone: "+49 123",
  arrivalTime: "17:30",
  specialRequests: "Quiet room",
};
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
const render = (choices: typeof rules | null, locked = false) =>
  act(() =>
    root.render(
      createElement(GuestDetailsForm, {
        value: ada,
        onChange: () => undefined,
        rules: choices,
        locked,
      }),
    ),
  );
const input = (name: string) => document.querySelector<HTMLInputElement>(`[name="${name}"]`);

it("shows the fields the hotel's rules ask for (VAY-2163)", () => {
  render(rules);
  expect(input("phone")!.required).toBe(true);
  expect(input("arrivalTime")).not.toBeNull();
  expect(document.querySelector('[name="specialRequests"]')).not.toBeNull();
  render({
    ...rules,
    phoneRequired: false,
    arrivalTimeEnabled: false,
    specialRequestsEnabled: false,
  });
  expect(input("phone")!.required).toBe(false);
  expect(document.body.textContent).toContain("Phone (optional)");
  expect(input("arrivalTime")).toBeNull();
  expect(document.querySelector('[name="specialRequests"]')).toBeNull();
});

it("requires the phone and hides the optional fields until the rules are known (VAY-2163)", () => {
  render(null);
  expect(input("phone")!.required).toBe(true);
  expect(document.body.textContent).not.toContain("Phone (optional)");
  expect(input("arrivalTime")).toBeNull();
  expect(document.querySelector('[name="specialRequests"]')).toBeNull();
});

it("locks the details while a booking attempt is open", () => {
  render(rules, true);
  expect(input("firstName")!.disabled).toBe(true);
  expect(input("email")!.disabled).toBe(true);
});

it("knows when the details are complete and sends only the fields the rules ask for", () => {
  expect(guestComplete(ada, rules)).toBe(true);
  expect(guestComplete({ ...ada, phone: " " }, rules)).toBe(false);
  expect(guestComplete({ ...ada, phone: "" }, { ...rules, phoneRequired: false })).toBe(true);
  expect(guestComplete({ ...ada, phone: "" }, null)).toBe(false);
  expect(guestComplete({ ...ada, email: "ada@" }, rules)).toBe(false);
  expect(guestComplete({ ...ada, countryCode: "DEU" }, rules)).toBe(false);
  expect(
    acceptanceGuest(ada, { ...rules, arrivalTimeEnabled: false, specialRequestsEnabled: false }),
  ).toEqual({
    ...ada,
    arrivalTime: "",
    specialRequests: "",
  });
});
