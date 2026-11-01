import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import GoogleMapsLinkField from "./GoogleMapsLinkField";

const messages = {
  resolving: "Reading the short link…",
  label: "Google Maps link",
  hint: "Copy the link of a place or a dropped pin.",
  placed: (coordinates: string) => `Pin placed at ${coordinates}`,
  shortLink: "Short links carry no coordinates.",
  noPin: "No place in this link.",
  searchInstead: "Search an address instead",
};

function render(resolveShortLink: ((url: string) => Promise<string | null>) | null = null) {
  const onPin = vi.fn();
  const onClose = vi.fn();
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <GoogleMapsLinkField
        inputId="link"
        messages={messages}
        onPin={onPin}
        onClose={onClose}
        classNames={{ label: "label", input: "input", link: "link" }}
        resolveShortLink={resolveShortLink}
      />,
    );
  });
  const input = () => renderer.root.findByProps({ id: "link" });
  const result = () => renderer.root.findByProps({ id: "link-result" });
  const type = (value: string) => act(() => input().props.onChange({ target: { value } }));
  return { renderer, onPin, onClose, input, result, type };
}

describe("GoogleMapsLinkField (VAY-2321, VAY-2444)", () => {
  it("places the pin from a link and says where", () => {
    const field = render();
    expect(field.result().props.children).toBe(messages.hint);
    field.type("https://www.google.com/maps/place/x/@6.02,80.21,17z/data=!3d6.0275!4d80.2172");
    expect(field.onPin).toHaveBeenCalledWith({ latitude: 6.0275, longitude: 80.2172 });
    expect(field.result().props.children).toBe("Pin placed at 6.0275, 80.2172");
    expect(field.result().props.className).toContain("text-green-700");
  });

  it("explains a short link and a link without a place, without placing a pin", () => {
    const field = render();
    field.type("https://maps.app.goo.gl/abc");
    expect(field.result().props.children).toBe(messages.shortLink);
    field.type("https://example.com/@6.02,80.21");
    expect(field.result().props.children).toBe(messages.noPin);
    expect(field.result().props.className).toContain("text-amber-700");
    field.type("  ");
    expect(field.result().props.children).toBe(messages.hint);
    expect(field.onPin).not.toHaveBeenCalled();
  });

  it("keeps Enter from submitting the surrounding form, and goes back to search", () => {
    const field = render();
    const preventDefault = vi.fn();
    act(() => field.input().props.onKeyDown({ key: "Enter", preventDefault }));
    expect(preventDefault).toHaveBeenCalled();
    act(() => field.renderer.root.findByProps({ type: "button" }).props.onClick());
    expect(field.onClose).toHaveBeenCalled();
  });

  it("reads a short link's long link through the API, once the typing pauses", async () => {
    vi.useFakeTimers();
    try {
      const resolve = vi.fn(async (url: string) =>
        url.endsWith("/good")
          ? "https://www.google.com/maps/place/x/data=!3d5.9762!4d80.7063"
          : null,
      );
      const field = render(resolve);
      field.type("https://maps.app.goo.gl/goo");
      field.type("https://maps.app.goo.gl/good");
      expect(field.result().props.children).toBe(messages.resolving);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      // Only the last text was read.
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(field.onPin).toHaveBeenCalledWith({ latitude: 5.9762, longitude: 80.7063 });
      expect(field.result().props.children).toBe("Pin placed at 5.9762, 80.7063");

      field.type("https://maps.app.goo.gl/bad");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(field.result().props.children).toBe(messages.shortLink);
      expect(field.onPin).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops an answer that arrives after the text changed", async () => {
    vi.useFakeTimers();
    try {
      let answer!: (url: string | null) => void;
      const field = render(() => new Promise((resolve) => (answer = resolve)));
      field.type("https://maps.app.goo.gl/abc");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      field.type("https://example.com");
      await act(async () => answer("https://www.google.com/maps/@6.03,80.21,17z"));
      expect(field.onPin).not.toHaveBeenCalled();
      expect(field.result().props.children).toBe(messages.noPin);
    } finally {
      vi.useRealTimers();
    }
  });
});
