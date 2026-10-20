import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import {
  QuickHotelAddress,
  formattedAddress,
  type QuickHotelAddressProps,
} from "./QuickHotelAddress";

const google = vi.hoisted(() => ({
  findAddressOnMap: vi.fn(async () => ({ position: { lat: 48.1351, lng: 11.582 }, precise: true })),
}));

vi.mock("@vayada/product-onboarding/GooglePlacesAddressField", () => ({
  default: ({
    onSelect,
    onUnavailable,
  }: {
    onSelect: (a: unknown, e: boolean) => void;
    onUnavailable: (f: boolean) => void;
  }) => (
    <div data-testid="places">
      <button
        type="button"
        data-testid="pick"
        onClick={() =>
          onSelect(
            {
              streetAddress: "Sendlinger Straße 12",
              postalCode: "80331",
              city: "Munich",
              countryCode: "DE",
              region: "Bavaria",
              latitude: 48.1351,
              longitude: 11.582,
            },
            true,
          )
        }
      />
      <button type="button" data-testid="fail" onClick={() => onUnavailable(false)} />
    </div>
  ),
}));
vi.mock("@vayada/product-onboarding/GoogleAddressMap", () => ({
  default: (props: { onPick?: unknown }) => (
    <div data-testid="map" data-interactive={props.onPick ? "yes" : "no"} />
  ),
}));
vi.mock("@vayada/product-onboarding/googleMaps", () => google);
vi.mock("@vayada/product-onboarding/TimezoneField", () => ({
  default: ({ onChange }: { onChange: (value: string) => void }) => (
    <button type="button" data-testid="pick-timezone" onClick={() => onChange("Europe/Vienna")} />
  ),
}));

const EMPTY = {
  streetAddress: "",
  postalCode: "",
  city: "",
  countryCode: "",
  latitude: null,
  longitude: null,
  timezone: "",
};
const PICKED = {
  streetAddress: "Sendlinger Straße 12",
  postalCode: "80331",
  city: "Munich",
  countryCode: "DE",
  latitude: 48.1351,
  longitude: 11.582,
  timezone: "Europe/Berlin",
};

function render(overrides: Partial<QuickHotelAddressProps> = {}) {
  const onChange = vi.fn();
  const renderer = create(
    <QuickHotelAddress draft={EMPTY} onChange={onChange} apiKey="key" {...overrides} />,
  );
  return { renderer, onChange };
}

const byTestId = (renderer: ReactTestRenderer, id: string) =>
  renderer.root.findAll((node) => node.props["data-testid"] === id);
const buttonNamed = (renderer: ReactTestRenderer, name: string) =>
  renderer.root.find((node) => node.type === "button" && node.children.join("") === name);
const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());

describe("QuickHotelAddress (VAY-2247 'Where it is')", () => {
  it("searches first, and a picked address fills the fields, the pin and the time zone", async () => {
    const { renderer, onChange } = render();
    expect(byTestId(renderer, "places")).toHaveLength(1);
    expect(text(renderer)).toContain("We place your hotel on the map and pick the time zone");
    expect(text(renderer)).toContain("Set from your address");
    expect(text(renderer)).toContain("Set from your country");
    await act(async () => byTestId(renderer, "pick")[0]!.props.onClick());
    expect(onChange).toHaveBeenCalledWith(PICKED);
    renderer.unmount();
  });

  it("shows a found address with its pin, map, time zone and currency, each with a way to change it", async () => {
    const onChangeCurrency = vi.fn();
    const { renderer, onChange } = render({
      draft: PICKED,
      currency: { label: "EUR (€)", note: "From Germany" },
      onChangeCurrency,
    });
    expect(text(renderer)).toContain("Sendlinger Straße 12, 80331 Munich, Germany");
    expect(text(renderer)).toContain("Pin placed on the map");
    expect(byTestId(renderer, "map")[0]!.props["data-interactive"]).toBe("no");
    expect(text(renderer)).toContain("Europe/Berlin");
    expect(text(renderer)).toContain("From Germany · used for every price");

    await act(async () => buttonNamed(renderer, "Adjust").props.onClick());
    expect(byTestId(renderer, "map")[0]!.props["data-interactive"]).toBe("yes");
    expect(text(renderer)).toContain("Drag the pin to your entrance.");

    const changes = renderer.root.findAll(
      (node) => node.type === "button" && node.children.join("") === "Change",
    );
    // Address, time zone, currency.
    expect(changes).toHaveLength(3);
    await act(async () => changes[2]!.props.onClick());
    expect(onChangeCurrency).toHaveBeenCalledOnce();
    await act(async () => changes[1]!.props.onClick());
    await act(async () => byTestId(renderer, "pick-timezone")[0]!.props.onClick());
    expect(onChange).toHaveBeenLastCalledWith({ timezone: "Europe/Vienna" });
    renderer.unmount();
  });

  it("falls back to typing the address, and a typed edit drops the old pin", async () => {
    const { renderer, onChange } = render();
    await act(async () =>
      buttonNamed(renderer, "Can't find it? Enter the address manually").props.onClick(),
    );
    const inputs = renderer.root.findAllByType("input");
    expect(inputs).toHaveLength(3);
    await act(async () => inputs[2]!.props.onChange({ target: { value: "Munich" } }));
    expect(onChange).toHaveBeenLastCalledWith({ city: "Munich", latitude: null, longitude: null });
    await act(async () =>
      renderer.root.findByType("select").props.onChange({ target: { value: "DE" } }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      countryCode: "DE",
      latitude: null,
      longitude: null,
      timezone: "Europe/Berlin",
    });
    expect(byTestId(renderer, "places")).toHaveLength(0);
    await act(async () => buttonNamed(renderer, "Search instead").props.onClick());
    expect(byTestId(renderer, "places")).toHaveLength(1);
    renderer.unmount();
  });

  it("places the first pin for a typed address", async () => {
    vi.useFakeTimers();
    try {
      const { renderer, onChange } = render({
        draft: { ...PICKED, latitude: null, longitude: null, timezone: "" },
      });
      // A complete address without a pin opens in the summary; Change → search, then type it in.
      await act(async () => buttonNamed(renderer, "Change").props.onClick());
      await act(async () =>
        buttonNamed(renderer, "Can't find it? Enter the address manually").props.onClick(),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(google.findAddressOnMap).toHaveBeenCalledWith(
        "key",
        "Sendlinger Straße 12, 80331 Munich, Germany",
      );
      expect(onChange).toHaveBeenLastCalledWith({
        latitude: 48.1351,
        longitude: 11.582,
        timezone: "Europe/Berlin",
      });
      renderer.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes straight to typing when search is unavailable or there is no Maps key", async () => {
    const { renderer } = render();
    await act(async () => byTestId(renderer, "fail")[0]!.props.onClick());
    expect(renderer.root.findAllByType("input")).toHaveLength(3);
    renderer.unmount();
    const keyless = render({ apiKey: null, draft: PICKED });
    expect(byTestId(keyless.renderer, "map")).toHaveLength(0);
    keyless.renderer.unmount();
    const typing = render({ apiKey: null });
    expect(typing.renderer.root.findAllByType("input")).toHaveLength(3);
    expect(text(typing.renderer)).not.toContain("Search instead");
    typing.renderer.unmount();
  });

  it("writes the address the way guests read it", () => {
    expect(formattedAddress(PICKED)).toBe("Sendlinger Straße 12, 80331 Munich, Germany");
    expect(formattedAddress({ ...PICKED, postalCode: "", countryCode: "" })).toBe(
      "Sendlinger Straße 12, Munich",
    );
  });
});
