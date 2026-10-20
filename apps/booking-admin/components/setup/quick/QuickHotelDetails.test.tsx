import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  QuickContactsFromAccountNote,
  QuickCurrencyPicker,
  QuickUseMyDetails,
} from "./QuickHotelDetails";
import { currencyChoices, currencySymbol, quickHotelCurrency } from "./quickHotelCurrency";

describe("quickHotelCurrency (VAY-2247)", () => {
  it("follows the country with the server's table, as code and symbol", () => {
    expect(quickHotelCurrency("DE", "")).toEqual({
      code: "EUR",
      symbol: "€",
      label: "EUR (€)",
      note: "From Germany",
      fromCountry: true,
    });
    expect(quickHotelCurrency("LK", "")).toMatchObject({ code: "LKR", note: "From Sri Lanka" });
    expect(quickHotelCurrency("BG", "")).toMatchObject({ code: "EUR" });
  });

  it("keeps the owner's choice, and waits for a known country", () => {
    expect(quickHotelCurrency("DE", "CHF")).toMatchObject({
      code: "CHF",
      note: "Chosen by you",
      fromCountry: false,
    });
    expect(quickHotelCurrency("DE", "EUR")).toMatchObject({ note: "From Germany" });
    expect(quickHotelCurrency("DE", "XYZ")).toMatchObject({ code: "EUR" });
    expect(quickHotelCurrency("", "")).toBeNull();
    expect(quickHotelCurrency("XX", "EUR")).toBeNull();
  });

  it("shows the code alone where a currency has no symbol of its own", () => {
    expect(currencySymbol("EUR")).toBe("€");
    expect(currencySymbol("NOT")).toBe("NOT");
    const chf = quickHotelCurrency("CH", "");
    expect(chf?.label === "CHF" || chf?.label === `CHF (${chf?.symbol})`).toBe(true);
  });

  it("offers the popular currencies first", () => {
    expect(
      currencyChoices()
        .slice(0, 3)
        .map((option) => option.code),
    ).toEqual(["USD", "EUR", "GBP"]);
    expect(new Set(currencyChoices().map((option) => option.code)).size).toBe(
      currencyChoices().length,
    );
  });
});

describe("Your hotel details (VAY-2247)", () => {
  it("copies the account's contacts on 'Use my details'", async () => {
    const onUse = vi.fn();
    const renderer = create(
      <QuickUseMyDetails email="clara@example.com" phone="+49 30 0000 0000" onUse={onUse} />,
    );
    expect(JSON.stringify(renderer.toJSON())).toContain("clara@example.com · +49 30 0000 0000");
    await act(async () => renderer.root.findByType("button").props.onClick());
    expect(onUse).toHaveBeenCalledOnce();
    renderer.unmount();
  });

  it("says where the contacts came from", () => {
    expect(renderToStaticMarkup(<QuickContactsFromAccountNote />)).toContain(
      "Filled from your account. Guests will see these — change them if your reception uses others.",
    );
  });

  it("lets the owner pick another currency", async () => {
    const onChange = vi.fn();
    const renderer = create(<QuickCurrencyPicker value="EUR" onChange={onChange} />);
    const select = renderer.root.findByType("select");
    expect(select.props.value).toBe("EUR");
    await act(async () => select.props.onChange({ target: { value: "CHF" } }));
    expect(onChange).toHaveBeenCalledWith("CHF");
    renderer.unmount();
  });
});
