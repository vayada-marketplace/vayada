import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  CountryPhoneField,
  defaultPhoneCountry,
  matchPhoneCountries,
  orderedPhoneCountries,
  phoneParts,
  phoneValue,
} from "./CountryPhoneField";

describe("phone as country + number (VAY-2247)", () => {
  it("splits a stored number into its country and the national part", () => {
    expect(phoneParts("+43 1 234567", "DE")).toEqual({ country: "AT", national: "1 234567" });
    expect(phoneParts("+49 30 1234567", "AT")).toEqual({ country: "DE", national: "30 1234567" });
    expect(phoneParts("", "LK")).toEqual({ country: "LK", national: "" });
    // Something we can't parse stays as typed, in the fallback country.
    expect(phoneParts("030 12", "DE")).toEqual({ country: "DE", national: "030 12" });
  });

  it("stores one international number, without the national trunk zero", () => {
    expect(phoneValue("DE", "030 1234567")).toBe("+49 30 1234567");
    expect(phoneValue("AT", "  ")).toBe("");
    expect(phoneValue("DE", "+43 1 234567")).toBe("+43 1 234567");
    // Not a valid number yet: kept with the dial code, so the form can say what's wrong.
    expect(phoneValue("DE", "12")).toBe("+49 12");
  });

  it("starts in the hotel's country, else the browser's region, else Germany", () => {
    expect(defaultPhoneCountry("lk")).toBe("LK");
    expect(defaultPhoneCountry(null, "fr-CH")).toBe("CH");
    expect(defaultPhoneCountry(undefined, "en")).toBe("US");
    expect(defaultPhoneCountry("XX", "not a locale!")).toBe("DE");
  });

  it("lists the hotel's country first and finds others by name, code or dial code", () => {
    const list = orderedPhoneCountries("LK");
    expect(list[0]).toMatchObject({ code: "LK", dial: "+94" });
    expect(list[1]!.name < list[2]!.name).toBe(true);
    expect(matchPhoneCountries(list, "austr").map(({ code }) => code)).toEqual(["AU", "AT"]);
    expect(matchPhoneCountries(list, "+43").map(({ code }) => code)).toEqual(["AT"]);
    expect(matchPhoneCountries(list, "ch").map(({ code }) => code)).toContain("CH");
  });
});

function render(props: Partial<Parameters<typeof CountryPhoneField>[0]> = {}) {
  const onChange = vi.fn();
  let renderer: ReactTestRenderer;
  act(() => {
    renderer = create(
      <CountryPhoneField
        label="Your phone"
        value=""
        onChange={onChange}
        defaultCountry="DE"
        required
        {...props}
      />,
    );
  });
  const button = () => renderer.root.findByProps({ "aria-haspopup": "listbox" });
  const number = () => renderer.root.findByProps({ type: "tel" });
  return { renderer: renderer!, onChange, button, number };
}

describe("CountryPhoneField", () => {
  it("shows the hotel's country and sends the number with its dial code", () => {
    const field = render();
    expect(field.button().props["aria-label"]).toBe("Your phone country: Germany +49");
    act(() => field.number().props.onChange({ target: { value: "030 1234567" } }));
    expect(field.onChange).toHaveBeenLastCalledWith("+49 30 1234567");
  });

  it("picks another country from the searchable list and keeps the number", () => {
    const field = render({ value: "+49 30 1234567" });
    act(() => field.button().props.onClick());
    const search = field.renderer.root.findByProps({ role: "combobox" });
    act(() => search.props.onChange({ target: { value: "austria" } }));
    const options = field.renderer.root.findAllByProps({ role: "option" });
    expect(options.map((option) => option.props.id.split("-").at(-1))).toEqual(["AT"]);
    act(() => search.props.onKeyDown({ key: "Enter", preventDefault: () => undefined }));
    expect(field.onChange).toHaveBeenLastCalledWith("+43 30 1234567");
    expect(field.renderer.root.findAllByProps({ role: "listbox" })).toHaveLength(0);
  });

  it("closes the list on Escape without changing the number", () => {
    const field = render({ value: "+49 30 1234567" });
    act(() => field.button().props.onClick());
    const search = field.renderer.root.findByProps({ role: "combobox" });
    act(() => search.props.onKeyDown({ key: "Escape", preventDefault: () => undefined }));
    expect(field.renderer.root.findAllByProps({ role: "listbox" })).toHaveLength(0);
    expect(field.onChange).not.toHaveBeenCalled();
  });

  it("takes a pasted international number with its own country", () => {
    const field = render();
    act(() => field.number().props.onChange({ target: { value: "+43 1 234567" } }));
    expect(field.button().props["aria-label"]).toBe("Your phone country: Austria +43");
    expect(field.onChange).toHaveBeenLastCalledWith("+43 1 234567");
  });

  it("follows a number set from outside, such as 'Use my details'", () => {
    const field = render({ value: "" });
    act(() => {
      field.renderer.update(
        <CountryPhoneField
          label="Your phone"
          value="+43 1 234567"
          onChange={field.onChange}
          defaultCountry="DE"
        />,
      );
    });
    expect(field.number().props.value).toBe("1 234567");
    expect(field.button().props["aria-label"]).toBe("Your phone country: Austria +43");
  });

  it("shows the error instead of the helper", () => {
    const field = render({ helper: "Not shown to guests.", error: "Enter a valid phone number." });
    expect(field.number().props["aria-invalid"]).toBe(true);
    const texts = field.renderer.root.findAllByType("p").map((p) => p.children.join(""));
    expect(texts.join(" ")).toContain("Enter a valid phone number.");
    expect(texts.join(" ")).not.toContain("Not shown to guests.");
  });
});
