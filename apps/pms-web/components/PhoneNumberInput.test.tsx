import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import PhoneNumberInput, { phoneCountryOrEmpty, phoneToE164 } from "./PhoneNumberInput";

describe("phoneToE164", () => {
  it("combines the selected country code with a national number", () => {
    expect(phoneToE164("DE", "089 1234567")).toBe("+49891234567");
    expect(phoneToE164("ID", "0812-3456-7890")).toBe("+6281234567890");
    expect(phoneToE164("ID", "0361 123456")).toBe("+62361123456");
  });

  it("keeps an explicitly international number regardless of the selected code", () => {
    expect(phoneToE164("DE", "+44 20 7946 0958")).toBe("+442079460958");
    expect(phoneToE164("", "+61 412 345 678")).toBe("+61412345678");
  });

  it("treats an empty number as no phone", () => {
    expect(phoneToE164("DE", "  ")).toBe("");
  });

  it.each([
    ["DE", "12"],
    ["", "0891234567"],
    ["ID", "0812345"],
    ["US", "123 456 7890"],
    ["US", "000 000 0000"],
    ["AU", "0412 345 67"],
    ["DE", "089 1234567 ext. 12"],
    ["DE", "call me 089 1234567"],
    ["DE", "+49 89 1234567890123"],
  ])("rejects %s %s instead of storing an invalid number", (country, number) => {
    expect(phoneToE164(country, number)).toBeNull();
  });
});

describe("PhoneNumberInput", () => {
  it("only defaults to countries offered in the list", () => {
    expect(phoneCountryOrEmpty("id")).toBe("ID");
    expect(phoneCountryOrEmpty("XX")).toBe("");
    expect(phoneCountryOrEmpty(null)).toBe("");
  });

  function render(number: string, onChange = vi.fn()) {
    const view = create(
      createElement(PhoneNumberInput, {
        label: "Phone",
        countryLabel: "Phone country code",
        countryPlaceholder: "Code",
        country: "DE",
        number,
        onChange,
        inputClassName: "input",
      }),
    );
    return {
      view,
      onChange,
      blur: () => act(() => view.root.findByProps({ type: "tel" }).props.onBlur()),
    };
  }

  it("lists countries by name and shows flag and calling code when closed", () => {
    const { view } = render("");
    const select = view.root.findByProps({ "aria-label": "Phone country code" });
    expect(select.props.value).toBe("DE");
    expect(
      select
        .findAllByType("option")
        .some((option) => option.children.join("") === "Germany 🇩🇪 +49"),
    ).toBe(true);
    expect(view.root.findByProps({ className: "truncate" }).children.join("")).toBe("🇩🇪 +49");
  });

  it("adopts the country of a pasted valid international number", () => {
    const { onChange, blur } = render("+62 812 3456 7890");
    blur();
    expect(onChange).toHaveBeenCalledWith({ country: "ID", number: "0812-3456-7890" });
  });

  it("leaves national and invalid numbers alone on blur", () => {
    for (const number of ["089 1234567", "+49 89 1234567890123"]) {
      const { onChange, blur } = render(number);
      blur();
      expect(onChange).not.toHaveBeenCalled();
    }
  });
});
