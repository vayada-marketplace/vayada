import { createRequire } from "node:module";

import { matchRemotePattern } from "next/dist/shared/lib/match-remote-pattern";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const config = require("./next.config.js") as {
  images: { remotePatterns: Parameters<typeof matchRemotePattern>[0][] };
};

const allowed = (url: string) =>
  config.images.remotePatterns.some((pattern) => matchRemotePattern(pattern, new URL(url)));

describe("next.config images", () => {
  it("lets next/image optimize published platform media", () => {
    expect(
      allowed(
        "https://images.vayada.com/media/353fbce8-26c7-4722-95bf-aaeb71c83b02/original_safe/publication-8f228c4a-ff0e-46e0-9f0c-29fe9e145c85.webp",
      ),
    ).toBe(true);
    expect(allowed("http://images.vayada.com/media/photo.webp")).toBe(false);
    expect(allowed("https://example.org/photo.webp")).toBe(false);
  });
});
