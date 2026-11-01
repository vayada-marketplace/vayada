import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

// Google's map itself is out of scope here: the stand-in records what the frame asks of it.
vi.mock("./GoogleAddressMap", () => ({
  default: (props: Record<string, unknown>) => <div data-testid="map" {...stringProps(props)} />,
}));
function stringProps(props: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(props)
      .filter(([, value]) => typeof value !== "function")
      .map(([key, value]) => [`data-${key.toLowerCase()}`, JSON.stringify(value)]),
  );
}

import PinMapFrame from "./PinMapFrame";

const messages = {
  mapType: "Map type",
  mapView: "Map",
  satelliteView: "Satellite",
  dragPin: "Drag the pin to the exact spot",
  recenter: "Recenter",
  empty: "Search above, or click the map to drop the pin.",
};

function render(props: Partial<Parameters<typeof PinMapFrame>[0]> = {}) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <PinMapFrame
        apiKey="key"
        latitude={6.0275}
        longitude={80.2172}
        markerTitle="Pin"
        messages={messages}
        onPick={() => undefined}
        onUnavailable={() => undefined}
        focus={{ lat: 6, lng: 80 }}
        {...props}
      />,
    );
  });
  const text = () => JSON.stringify(renderer.toJSON());
  const map = () => renderer.root.findByProps({ "data-testid": "map" }).props;
  return { renderer, text, map };
}

describe("PinMapFrame (VAY-2321, VAY-2444)", () => {
  it("shows the drag hint and Recenter with a pin, and doesn't steer the map by focus", () => {
    const frame = render();
    expect(frame.text()).toContain(messages.dragPin);
    expect(frame.text()).toContain(messages.recenter);
    expect(frame.text()).not.toContain(messages.empty);
    expect(frame.map()["data-focus"]).toBe("null");
  });

  it("asks for a pin without one, opening on the focus", () => {
    const frame = render({ latitude: null, longitude: null });
    expect(frame.text()).toContain(messages.empty);
    expect(frame.text()).not.toContain(messages.dragPin);
    expect(frame.text()).not.toContain(messages.recenter);
    expect(frame.map()["data-focus"]).toBe(JSON.stringify({ lat: 6, lng: 80 }));
  });

  it("drops the drag hint for an area, and switches between Map and Satellite", () => {
    const frame = render({ area: true });
    expect(frame.text()).not.toContain(messages.dragPin);
    const pressed = (value: boolean) => frame.renderer.root.findByProps({ "aria-pressed": value });
    expect(pressed(true).props.children).toBe("Map");
    act(() => pressed(false).props.onClick());
    expect(frame.map()["data-maptype"]).toBe(JSON.stringify("satellite"));
    expect(pressed(true).props.children).toBe("Satellite");
  });
});
