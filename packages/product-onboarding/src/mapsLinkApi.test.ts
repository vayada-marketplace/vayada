import { describe, expect, it, vi } from "vitest";

import { createMapsLinkApi } from "./mapsLinkApi";

describe("createMapsLinkApi (VAY-2444)", () => {
  it("asks the API for the long link and returns it", async () => {
    const post = vi.fn(async () => ({ url: "https://www.google.com/maps/@6.03,80.21,17z" }));
    const api = createMapsLinkApi({ post } as never);
    expect(await api.resolveShortLink("https://maps.app.goo.gl/abc")).toBe(
      "https://www.google.com/maps/@6.03,80.21,17z",
    );
    expect(post).toHaveBeenCalledWith("/api/maps-links/resolve", {
      url: "https://maps.app.goo.gl/abc",
    });
  });

  it("returns null when the API refuses, fails or answers something else", async () => {
    for (const post of [
      vi.fn(async () => {
        throw new Error("404");
      }),
      vi.fn(async () => ({})),
      vi.fn(async () => ({ url: 42 })),
      vi.fn(async () => null),
    ])
      expect(await createMapsLinkApi({ post } as never).resolveShortLink("x")).toBeNull();
  });
});
