import { describe, expect, it } from "vitest";

import { ConfigError, loadServerConfig, readIntegerEnv } from "./index.js";

describe("backend-config", () => {
  it("loads server defaults when env values are absent", () => {
    expect(loadServerConfig({}, { host: "0.0.0.0", port: 8003 })).toEqual({
      host: "0.0.0.0",
      port: 8003,
    });
  });

  it("rejects invalid integer env values", () => {
    expect(() =>
      readIntegerEnv({ PORT: "70000" }, "PORT", {
        defaultValue: 8003,
        max: 65535,
      }),
    ).toThrow(ConfigError);
  });
});
