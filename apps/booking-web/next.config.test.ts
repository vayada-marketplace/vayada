import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("next.config images", () => {
  it("lets next/image optimize published platform media", () => {
    const config = require("./next.config.js") as {
      images: { remotePatterns: Array<{ protocol: string; hostname: string }> };
    };

    expect(config.images.remotePatterns).toContainEqual(
      expect.objectContaining({ protocol: "https", hostname: "images.vayada.com" }),
    );
  });
});
