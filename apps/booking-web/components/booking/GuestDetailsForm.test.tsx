/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicQuoteGuestDisclosure } from "@vayada/domain-booking/replacement-pricing";
import en from "@/messages/en.json";
import de from "@/messages/de.json";
import GuestDetailsForm, {
  acceptanceGuest,
  emptyGuest,
  guestComplete,
  guestErrors,
  phoneE164,
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
  phone: "+49 151 2345 6789",
  countryCode: "GB",
  arrivalTime: "17:30",
  specialRequests: "Quiet room",
};
let root: Root;
let change = vi.fn<(value: GuestDetails) => void>();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-DE"]);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  change = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const render = (
  choices: typeof rules | null,
  { value = ada, locked = false, showErrors = false, locale = "en" } = {},
) =>
  act(() =>
    root.render(
      createElement(NextIntlClientProvider, {
        locale,
        messages: locale === "de" ? de : en,
        children: createElement(GuestDetailsForm, {
          value,
          onChange: change,
          rules: choices,
          locked,
          showErrors,
        }),
      }),
    ),
  );
const input = (name: string) => document.querySelector<HTMLInputElement>(`[name="${name}"]`);
const type = (name: string, text: string) =>
  act(() => {
    const field = input(name)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });

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
  render(rules, { locked: true });
  expect(input("firstName")!.disabled).toBe(true);
  expect(input("email")!.disabled).toBe(true);
  expect(document.querySelector<HTMLSelectElement>('[name="phoneCountry"]')!.disabled).toBe(true);
});

it("gives every field an example, its autofill name and its hint (VAY-2347)", () => {
  render(rules);
  expect(document.querySelector("h2")!.textContent).toBe("Who’s staying?");
  expect(input("firstName")!.placeholder).toBe("John");
  expect(input("lastName")!.placeholder).toBe("Doe");
  expect(input("email")!.placeholder).toBe("john.doe@example.com");
  expect(input("phone")!.placeholder).toBe("151 2345 6789");
  expect(
    Object.fromEntries(
      Array.from(document.querySelectorAll<HTMLInputElement>("[autocomplete]")).map((field) => [
        field.name,
        field.getAttribute("autocomplete"),
      ]),
    ),
  ).toEqual({
    firstName: "given-name",
    lastName: "family-name",
    email: "email",
    phoneCountry: "tel-country-code",
    phone: "tel-national",
    countryCode: "country-name",
  });
  expect(document.body.textContent).toContain("We send your confirmation here.");
  expect(document.body.textContent).toContain("Only used for your stay.");
  // The code sits next to the number; the stored number is split back into both.
  expect(document.querySelector<HTMLSelectElement>('[name="phoneCountry"]')!.value).toBe("DE");
  expect(input("phone")!.value).toBe("151 2345 6789");
});

it("speaks the page's language", () => {
  render(rules, { locale: "de" });
  expect(document.querySelector("h2")!.textContent).toBe("Wer übernachtet?");
  expect(input("firstName")!.placeholder).toBe("Max");
  expect(
    document.querySelector<HTMLSelectElement>('[name="countryCode"]')!.selectedOptions[0]!
      .textContent,
  ).toBe("Vereinigtes Königreich");
});

it("starts the code and the country of residence from the browser's language", () => {
  // A guest who hasn't filled anything in yet.
  render(rules, { value: emptyGuest });
  expect(document.querySelector<HTMLSelectElement>('[name="phoneCountry"]')!.value).toBe("DE");
  expect(change).toHaveBeenCalledWith({ ...emptyGuest, countryCode: "DE" });
  change.mockClear();
  type("phone", "151 2345");
  expect(change).toHaveBeenLastCalledWith({ ...emptyGuest, phone: "+49 151 2345" });
});

it("marks each wrong field and counts them once the guest tried to continue", () => {
  const value = { ...ada, lastName: " ", email: "ada@", phone: "" };
  render(rules, { value });
  expect(document.body.textContent).not.toContain("marked in red");
  render(rules, { value, showErrors: true });
  // Not a live region: the first wrong field's own message is read when it gets focus.
  expect(document.body.textContent).toContain("Check the 3 fields marked in red.");
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(input("firstName")!.getAttribute("aria-invalid")).toBeNull();
  for (const [name, message] of [
    ["lastName", "Enter your last name."],
    ["email", "Enter an email like name@example.com."],
    ["phone", "Enter your phone number."],
  ]) {
    const field = input(name)!;
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(field.getAttribute("aria-describedby")!)!.textContent).toBe(
      message,
    );
  }
});

it("flags a phone number too short to be one, and keeps a cleared country cleared", () => {
  render(rules, { value: { ...ada, phone: "+49 12" }, showErrors: true });
  const phone = input("phone")!;
  expect(phone.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(phone.getAttribute("aria-describedby")!)!.textContent).toBe(
    "Enter a valid phone number.",
  );
  expect(guestErrors({ ...ada, phone: "+" }, rules)).toEqual(["phone"]);
  // An older draft's number without a code is sent as typed.
  expect(guestErrors({ ...ada, phone: "030 1234567" }, rules)).toEqual([]);
  change.mockClear();
  render(rules, { value: { ...ada, countryCode: "" } });
  expect(change).not.toHaveBeenCalled();
});

it("shows a stored number's own code when it reopens", () => {
  render(rules, { value: { ...ada, phone: "+44 20 1234" } });
  expect(document.querySelector<HTMLSelectElement>('[name="phoneCountry"]')!.value).toBe("GB");
  expect(input("phone")!.value).toBe("20 1234");
});

it("knows when the details are complete and sends only the fields the rules ask for", () => {
  expect(guestComplete(ada, rules)).toBe(true);
  expect(guestErrors({ ...ada, firstName: "", phone: " " }, rules)).toEqual(["firstName", "phone"]);
  expect(guestComplete({ ...ada, phone: "" }, { ...rules, phoneRequired: false })).toBe(true);
  expect(guestComplete({ ...ada, phone: "" }, null)).toBe(false);
  expect(guestComplete({ ...ada, email: "ada@" }, rules)).toBe(false);
  expect(guestComplete({ ...ada, countryCode: "DEU" }, rules)).toBe(false);
  expect(
    acceptanceGuest(ada, { ...rules, arrivalTimeEnabled: false, specialRequestsEnabled: false }),
  ).toEqual({
    ...ada,
    phone: "+4915123456789",
    arrivalTime: "",
    specialRequests: "",
  });
});

it("sends the phone as E.164 (VAY-2347)", () => {
  expect(phoneE164("+49 151 2345 6789")).toBe("+4915123456789");
  // The trunk 0 a guest types after the code is not part of the number.
  expect(phoneE164("+44 07911 123456")).toBe("+447911123456");
  expect(phoneE164("")).toBe("");
  // A number from an older draft, typed without a code, is sent as typed.
  expect(phoneE164("030 1234567")).toBe("030 1234567");
});
