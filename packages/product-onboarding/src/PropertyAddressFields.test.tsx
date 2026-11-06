import { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

// Google itself is out of scope here: the stand-ins record what the form asks of it.
vi.mock("./GoogleAddressMap", () => ({
  default: (props: Record<string, unknown>) => <div data-testid="map" {...stringProps(props)} />,
}));
vi.mock("./GooglePlacesAddressField", () => ({
  default: () => <div data-testid="address-search" />,
}));
const google = vi.hoisted(() => ({
  addressFromPin: vi.fn(),
  findAddressOnMap: vi.fn(),
}));
vi.mock("./addressFromPin", () => ({ addressFromPin: google.addressFromPin }));
vi.mock("./googleMaps", () => ({ findAddressOnMap: google.findAddressOnMap }));
function stringProps(props: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(props)
      .filter(([, value]) => typeof value !== "function")
      .map(([key, value]) => [`data-${key.toLowerCase()}`, JSON.stringify(value)]),
  );
}

import PropertyAddressFields, {
  type PropertyAddress,
  type PropertyAddressLinkMode,
} from "./PropertyAddressFields";

const saved: PropertyAddress = {
  streetAddress: "Alpenstrasse 12",
  postalCode: "80331",
  city: "Munich",
  countryCode: "DE",
  latitude: 48.1372,
  longitude: 11.5756,
  area: "",
  arrivalDirections: "",
};
const link = "https://www.google.com/maps/place/X/data=!3d48.156341!4d11.58242";

function linkMode(onLookupChange = vi.fn()): PropertyAddressLinkMode {
  return {
    resolveShortLink: null,
    guestName: "Alpenrose Munich",
    onLookupChange,
    messages: {
      link: {
        label: "Google Maps link",
        hint: "Copy the link of a place or a dropped pin from Google Maps.",
        placed: (coordinates) => `Pin placed at ${coordinates}`,
        shortLink: "This short link couldn't be read.",
        noPin: "This link has no coordinates.",
        searchInstead: "Search an address instead",
      },
      pasteLink: "Paste a Google Maps link",
      map: {
        mapType: "Map type",
        mapView: "Map",
        satelliteView: "Satellite",
        dragPin: "Drag the pin to the exact spot",
        recenter: "Recenter",
        empty: "Paste a Google Maps link, or click the map to drop the pin.",
      },
      mapHint: "Click the map to place the pin, or drag it.",
      pinSet: "Pin set",
      guestsWillSee: "Guests will see",
      lookingUp: "Looking up the address…",
      noAddress: "No address yet.",
      noAddressForPin: "Google has no address for this pin.",
      coordinates: "Coordinates (advanced)",
    },
  };
}

function render(
  options: {
    value?: PropertyAddress;
    links?: PropertyAddressLinkMode | null;
    apiKey?: string;
  } = {},
) {
  const changes: Partial<PropertyAddress>[] = [];
  let latest = options.value ?? saved;
  function Harness() {
    const [value, setValue] = useState(options.value ?? saved);
    latest = value;
    return (
      <PropertyAddressFields
        value={value}
        onChange={(patch) => {
          changes.push(patch);
          setValue((current) => ({ ...current, ...patch }));
        }}
        apiKey={options.apiKey ?? "key"}
        linkMode={options.links === undefined ? linkMode() : options.links}
      />
    );
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness />);
  });
  const text = () => JSON.stringify(renderer.toJSON());
  const linkInput = () =>
    renderer.root.find(
      (node) =>
        node.type === "input" && node.props.placeholder === "https://www.google.com/maps/place/…",
    );
  const paste = (value: string) =>
    act(() => {
      linkInput().props.onChange({ target: { value } });
    });
  const field = (label: string) =>
    renderer.root
      .find(
        (node) =>
          node.type === "label" &&
          node.findAll((child) => child.children.includes(label)).length > 0,
      )
      .findByType("input");
  const type = (label: string, value: string) =>
    act(() => {
      field(label).props.onChange({ target: { value } });
    });
  const map = () => renderer.root.findByProps({ "data-testid": "map" }).props;
  return { renderer, text, changes, paste, type, map, value: () => latest };
}

describe("PropertyAddressFields (VAY-2322, VAY-2482)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps Booking Admin's form as it was without the link mode", () => {
    const form = render({ links: null, value: { ...saved, latitude: null, longitude: null } });
    expect(form.text()).toContain("Place the pin where guests should arrive");
    expect(form.text()).toContain('"Coordinates"');
    expect(form.text()).not.toContain("Google Maps link");
    expect(form.text()).not.toContain("Guests will see");
    expect(form.renderer.root.findAllByProps({ "data-testid": "address-search" })).toHaveLength(1);
    expect(google.findAddressOnMap).not.toHaveBeenCalled();
  });

  it("leaves the link mode out without a Maps key: no search to fall back on", () => {
    const form = render({ apiKey: "" });
    expect(form.text()).not.toContain("Google Maps link");
    expect(form.text()).not.toContain("Guests will see");
  });

  it("places the pin from a pasted link, then fills every field from Google", async () => {
    const onLookupChange = vi.fn();
    let answer!: (address: unknown) => void;
    google.addressFromPin.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const form = render({ links: linkMode(onLookupChange) });
    expect(form.text()).toContain("Pin set");
    expect(form.text()).toContain("Alpenstrasse 12, 80331 Munich, Germany");

    form.paste(link);
    expect(form.value()).toMatchObject({ latitude: 48.156341, longitude: 11.58242 });
    expect(google.addressFromPin).toHaveBeenCalledWith("key", { lat: 48.156341, lng: 11.58242 });
    expect(form.text()).toContain("Looking up the address…");
    expect(onLookupChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      answer({
        streetAddress: "Leopoldstraße 12",
        area: "Schwabing",
        postalCode: "80802",
        city: "München",
        countryCode: "DE",
        region: "Bayern",
        latitude: 48.156341,
        longitude: 11.58242,
        location: null,
      });
    });
    expect(form.value()).toMatchObject({
      streetAddress: "Leopoldstraße 12",
      area: "Schwabing",
      postalCode: "80802",
      city: "München",
      countryCode: "DE",
      latitude: 48.156341,
      longitude: 11.58242,
    });
    expect(form.text()).toContain("Leopoldstraße 12, Schwabing, 80802 München, Germany");
    expect(onLookupChange).toHaveBeenLastCalledWith(false);
  });

  it("drops a link's address that arrives after the host typed", async () => {
    let answer!: (address: unknown) => void;
    google.addressFromPin.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const onLookupChange = vi.fn();
    const form = render({ links: linkMode(onLookupChange) });
    form.paste(link);
    form.type("Street and number", "Leopoldstraße 12a");
    expect(onLookupChange).toHaveBeenLastCalledWith(false);
    await act(async () => {
      answer({
        streetAddress: "Leopoldstraße 12",
        area: "",
        postalCode: "80802",
        city: "München",
        countryCode: "DE",
      });
    });
    expect(form.value()).toMatchObject({
      streetAddress: "Leopoldstraße 12a",
      city: "Munich",
      latitude: 48.156341,
    });
  });

  it("keeps the fields and says so when Google has no address for the pin", async () => {
    google.addressFromPin.mockResolvedValueOnce(null);
    const form = render();
    form.paste(link);
    await act(async () => {});
    expect(form.value()).toMatchObject({ streetAddress: "Alpenstrasse 12", city: "Munich" });
    expect(form.text()).toContain("Google has no address for this pin.");
    expect(form.text()).toContain("Alpenstrasse 12, 80331 Munich, Germany");
    // The next edit clears the note.
    form.type("Postal code", "80333");
    expect(form.text()).not.toContain("Google has no address for this pin.");
  });

  it("opens the map on a saved address without a pin, never placing one", async () => {
    google.findAddressOnMap.mockResolvedValueOnce({
      position: { lat: 48.1373, lng: 11.5755 },
      precise: true,
    });
    const form = render({ value: { ...saved, latitude: null, longitude: null } });
    await act(async () => {});
    expect(google.findAddressOnMap).toHaveBeenCalledWith(
      "key",
      "Alpenstrasse 12, 80331 Munich, Germany",
    );
    expect(form.map()["data-focus"]).toBe(JSON.stringify({ lat: 48.1373, lng: 11.5755 }));
    expect(form.map()["data-latitude"]).toBe("null");
    expect(form.text()).toContain("Paste a Google Maps link, or click the map to drop the pin.");
    expect(form.changes).toEqual([]);
  });

  it("rounds a pin placed on the map to six decimals", () => {
    const form = render();
    const pick = form.renderer.root.findAll((node) => typeof node.props.onPick === "function")[0]
      .props.onPick as (position: { lat: number; lng: number }) => void;
    act(() => pick({ lat: 48.15651234, lng: 11.58301234 }));
    expect(form.value()).toMatchObject({ latitude: 48.156512, longitude: 11.583012 });
  });
});
