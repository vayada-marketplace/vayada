import { useState } from "react";
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
const reverse = vi.hoisted(() => ({ addressFromPin: vi.fn(async (): Promise<unknown> => null) }));

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
      <button
        type="button"
        data-testid="pick-street"
        onClick={() =>
          // A street without a house number: Google knows only the area, so no coordinates.
          onSelect(
            {
              streetAddress: "Isabella-Braun-Straße",
              postalCode: "89343",
              city: "Jettingen-Scheppach",
              countryCode: "DE",
              region: "Bavaria",
              latitude: null,
              longitude: null,
            },
            true,
          )
        }
      />
      <button type="button" data-testid="fail" onClick={() => onUnavailable(false)} />
    </div>
  ),
}));
vi.mock("@vayada/product-onboarding/PinMapFrame", () => ({
  default: (props: {
    onPick?: (position: { lat: number; lng: number }) => void;
    latitude: number | null;
    longitude: number | null;
  }) => (
    <div
      data-testid="map"
      data-interactive={props.onPick ? "yes" : "no"}
      data-position={props.latitude === null ? "none" : `${props.latitude},${props.longitude}`}
      onClick={() => props.onPick?.({ lat: 5.9765, lng: 80.7068 })}
    />
  ),
}));
vi.mock("@vayada/product-onboarding/googleMaps", () => google);
vi.mock("@vayada/product-onboarding/addressFromPin", () => reverse);
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
    const onCurrencyChange = vi.fn();
    const { renderer, onChange } = render({
      draft: PICKED,
      currency: { code: "EUR", label: "EUR (€)", note: "From Germany" },
      onCurrencyChange,
    });
    expect(text(renderer)).toContain("Sendlinger Straße 12, 80331 Munich, Germany");
    expect(text(renderer)).toContain("Pin placed on the map");
    // The room editor's map (VAY-2444): the pin can be dragged or placed by a click at once.
    expect(byTestId(renderer, "map")[0]!.props["data-interactive"]).toBe("yes");
    expect(text(renderer)).toContain("Guests will see");
    expect(text(renderer)).toContain("Europe/Berlin");
    expect(text(renderer)).toContain("From Germany · used for every price");

    const changes = renderer.root.findAll(
      (node) => node.type === "button" && node.children.join("") === "Change",
    );
    // Address, time zone, currency.
    expect(changes).toHaveLength(3);
    await act(async () => changes[2]!.props.onClick());
    await act(async () =>
      renderer.root
        .findByProps({ "aria-label": "Currency" })
        .props.onChange({ target: { value: "CHF" } }),
    );
    expect(onCurrencyChange).toHaveBeenCalledWith("CHF");
    expect(text(renderer)).toContain("EUR (€)");
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

  it("pins a picked street without a house number where Google finds it, then asks for the entrance", async () => {
    vi.useFakeTimers();
    google.findAddressOnMap.mockResolvedValueOnce({
      position: { lat: 48.3897, lng: 10.4378 },
      precise: false,
    });
    try {
      const Harness = () => {
        const [draft, setDraft] = useState<QuickHotelAddressProps["draft"]>(EMPTY);
        return (
          <QuickHotelAddress
            draft={draft}
            onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
            apiKey="key"
          />
        );
      };
      const renderer = create(<Harness />);
      await act(async () => byTestId(renderer, "pick-street")[0]!.props.onClick());
      // Before the lookup: no pin yet.
      expect(byTestId(renderer, "map")[0]!.props["data-position"]).toBe("none");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(google.findAddressOnMap).toHaveBeenLastCalledWith(
        "key",
        "Isabella-Braun-Straße, 89343 Jettingen-Scheppach, Germany",
      );
      // The map centres on the street with a pin, and opens to drag it to the entrance.
      const map = byTestId(renderer, "map")[0]!;
      expect(map.props["data-position"]).toBe("48.3897,10.4378");
      expect(map.props["data-interactive"]).toBe("yes");
      expect(text(renderer)).toContain("Pin placed on the map");
      expect(text(renderer)).toContain("Drag the pin to your entrance.");
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

  it("places the pin from a pasted Google Maps link and fills the address Google gives it (VAY-2444)", async () => {
    reverse.addressFromPin.mockResolvedValueOnce({
      streetAddress: "4th Lane",
      postalCode: "81200",
      city: "Dikwella",
      countryCode: "LK",
      region: "",
      latitude: 5.9762,
      longitude: 80.7063,
      location: { latitude: 5.9762, longitude: 80.7063 },
    });
    const changes: unknown[] = [];
    const Harness = () => {
      const [draft, setDraft] = useState<QuickHotelAddressProps["draft"]>(EMPTY);
      return (
        <QuickHotelAddress
          draft={draft}
          onChange={(patch) => {
            changes.push(patch);
            setDraft((current) => ({ ...current, ...patch }));
          }}
          apiKey="key"
          hotelName="Lumansa Hiriketiya"
        />
      );
    };
    const renderer = create(<Harness />);
    await act(async () => buttonNamed(renderer, "Paste a Google Maps link").props.onClick());
    const input = renderer.root.findByProps({ id: "quick-hotel-maps-link" });
    await act(async () =>
      input.props.onChange({
        target: {
          value:
            "https://www.google.com/maps/place/Lumansa/@5.97,80.70,17z/data=!3d5.9762!4d80.7063",
        },
      }),
    );
    expect(changes[0]).toEqual({ latitude: 5.9762, longitude: 80.7063, timezone: "Asia/Colombo" });
    expect(reverse.addressFromPin).toHaveBeenCalledWith("key", { lat: 5.9762, lng: 80.7063 });
    expect(changes[1]).toEqual({
      streetAddress: "4th Lane",
      postalCode: "81200",
      city: "Dikwella",
      countryCode: "LK",
    });
    // The summary with the address, the room editor's map and "Guests will see".
    expect(text(renderer)).toContain("4th Lane, 81200 Dikwella, Sri Lanka");
    expect(text(renderer)).toContain("Lumansa Hiriketiya");
    expect(byTestId(renderer, "map")[0]!.props["data-position"]).toBe("5.9762,80.7063");
    // Dragging or clicking the map moves the pin.
    await act(async () => byTestId(renderer, "map")[0]!.props.onClick());
    expect(changes.at(-1)).toEqual({
      latitude: 5.9765,
      longitude: 80.7068,
      timezone: "Asia/Colombo",
    });
    renderer.unmount();
  });

  it("keeps a link's pin when Google has no address, guessing the country for the owner to type the rest", async () => {
    const Harness = () => {
      const [draft, setDraft] = useState<QuickHotelAddressProps["draft"]>(EMPTY);
      return (
        <QuickHotelAddress
          draft={draft}
          onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
          apiKey="key"
        />
      );
    };
    const renderer = create(<Harness />);
    await act(async () => buttonNamed(renderer, "Paste a Google Maps link").props.onClick());
    await act(async () =>
      renderer.root
        .findByProps({ id: "quick-hotel-maps-link" })
        .props.onChange({ target: { value: "https://maps.google.com/?q=5.9762,80.7063" } }),
    );
    // Typing the address now: the pin stays.
    const inputs = renderer.root.findAllByType("input");
    expect(inputs).toHaveLength(3);
    expect(renderer.root.findByType("select").props.value).toBe("LK");
    await act(async () => inputs[0]!.props.onChange({ target: { value: "4th Lane" } }));
    expect(byTestId(renderer, "map")[0]!.props["data-position"]).toBe("5.9762,80.7063");
    renderer.unmount();
  });

  it("explains a link without a place, and goes back to search", async () => {
    const { renderer, onChange } = render();
    await act(async () => buttonNamed(renderer, "Paste a Google Maps link").props.onClick());
    await act(async () =>
      renderer.root
        .findByProps({ id: "quick-hotel-maps-link" })
        .props.onChange({ target: { value: "https://example.com/hotel" } }),
    );
    expect(text(renderer)).toContain("This link has no coordinates.");
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => buttonNamed(renderer, "Search an address instead").props.onClick());
    expect(byTestId(renderer, "places")).toHaveLength(1);
    renderer.unmount();
  });

  it("writes the address the way guests read it", () => {
    expect(formattedAddress(PICKED)).toBe("Sendlinger Straße 12, 80331 Munich, Germany");
    expect(formattedAddress({ ...PICKED, postalCode: "", countryCode: "" })).toBe(
      "Sendlinger Straße 12, Munich",
    );
  });
});
