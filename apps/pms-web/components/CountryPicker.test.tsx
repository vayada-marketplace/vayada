import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import CountryPicker, {
  NATIONALITY_PICKER_OPTIONS,
  searchCountries,
  type CountryPickerOption,
} from "./CountryPicker";

const codes = (
  query: string,
  options: readonly CountryPickerOption[] = NATIONALITY_PICKER_OPTIONS,
) => searchCountries(options, query).map((match) => match.option.code);

const phoneOptions: CountryPickerOption[] = [
  { code: "AT", name: "Austria", callingCode: "+43" },
  { code: "DE", name: "Germany", callingCode: "+49" },
  { code: "GB", name: "United Kingdom", callingCode: "+44" },
  { code: "ID", name: "Indonesia", callingCode: "+62" },
];

describe("searchCountries", () => {
  it("ranks the exact code first, then names and nationalities starting with the search", () => {
    expect(codes("de")[0]).toBe("DE");
    expect(codes("German")).toEqual(["DE"]);
    expect(codes("swiss")).toEqual(["CH"]);
    // Starting with it, then a later word, alphabetically within each.
    expect(codes("guinea")).toEqual(["GN", "GW", "GQ", "PG"]);
    expect(codes("aland")).toEqual(["AX", "NZ"]);
    expect(codes("cote")).toEqual(["CI"]);
  });

  it("finds calling codes typed with or without +, the exact code first", () => {
    expect(codes("+4", phoneOptions)).toEqual(["AT", "DE", "GB"]);
    expect(codes("49", phoneOptions)).toEqual(["DE"]);
    expect(codes("+6", phoneOptions)).toEqual(["ID"]);
  });

  it("bolds what matched", () => {
    const [match] = searchCountries(NATIONALITY_PICKER_OPTIONS, "germ");
    expect(match).toMatchObject({ text: "Germany", start: 0, end: 4 });
  });
});

describe("CountryPicker", () => {
  function render(value = "", onChange = vi.fn()) {
    let view!: ReactTestRenderer;
    act(() => {
      view = create(
        createElement(CountryPicker, {
          label: "Nationality",
          options: NATIONALITY_PICKER_OPTIONS,
          value,
          onChange,
          placeholder: "Choose a country",
          suggested: ["LK", "DE", "LK", "ZZ"],
          display: "name",
          clearable: true,
        }),
      );
    });
    const trigger = () =>
      view.root.findByProps({ "aria-label": "Nationality", "aria-haspopup": "listbox" });
    const search = () => view.root.findByProps({ role: "combobox" });
    const key = (name: string) => {
      const event = { key: name, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      act(() => search().props.onKeyDown(event));
      return event;
    };
    return { view, onChange, trigger, search, key };
  }

  it("lists suggestions, then every country, as listbox options with SVG flags", () => {
    const { view, trigger } = render();
    expect(trigger().props["aria-expanded"]).toBe(false);
    act(() => trigger().props.onClick());
    expect(trigger().props["aria-expanded"]).toBe(true);
    const listbox = view.root.findByProps({ role: "listbox" });
    const options = listbox.findAllByProps({ role: "option" });
    // Duplicates and unknown codes are dropped from the suggestions.
    const flags = options.map(
      (option) => option.findByProps({ "aria-hidden": "true" }).props.className,
    );
    expect(flags.slice(0, 2)).toEqual([
      expect.stringContaining("fi-lk"),
      expect.stringContaining("fi-de"),
    ]);
    expect(options).toHaveLength(NATIONALITY_PICKER_OPTIONS.length + 2);
    expect(options.every((option) => option.props.className.includes("min-h-11"))).toBe(true);
    // No emoji flags: Windows Chrome shows them as letters (VAY-2417).
    expect(JSON.stringify(view.toJSON())).not.toMatch(/\uD83C[\uDDE6-\uDDFF]/);
  });

  it("moves with the arrow keys and picks with Enter, the first match by default", () => {
    const { onChange, trigger, search, key } = render();
    act(() => trigger().props.onClick());
    act(() => search().props.onChange({ target: { value: "ind" } }));
    expect(search().props["aria-activedescendant"]).toMatch(/-0$/);
    key("ArrowDown");
    expect(search().props["aria-activedescendant"]).toMatch(/-1$/);
    key("ArrowUp");
    const enter = key("Enter");
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith("IN");
    expect(trigger().props["aria-expanded"]).toBe(false);
  });

  it("closes on Escape without closing the modal around it, and says when nothing matches", () => {
    const { view, onChange, trigger, search, key } = render();
    act(() => trigger().props.onClick());
    act(() => search().props.onChange({ target: { value: "qqq" } }));
    expect(view.root.findAllByProps({ role: "option" })).toHaveLength(0);
    expect(JSON.stringify(view.toJSON())).toContain("No country matches “qqq”");
    const escape = key("Escape");
    expect(escape.stopPropagation).toHaveBeenCalled();
    expect(trigger().props["aria-expanded"]).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows the chosen country and clears it", () => {
    const { view, onChange, trigger } = render("DE");
    expect(trigger().props.value).toBe("DE");
    expect(view.root.findByProps({ id: trigger().props["aria-describedby"] }).children).toEqual([
      "Germany",
    ]);
    act(() => view.root.findByProps({ "aria-label": "Clear Nationality" }).props.onClick());
    expect(onChange).toHaveBeenCalledWith("");
  });
});
