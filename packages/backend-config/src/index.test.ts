import { describe, expect, it } from "vitest";

import { ConfigError, loadServerConfig, readIntegerEnv } from "./index.js";

describe("backend-config", () => {
  it("loads server defaults when env values are absent", () => {
    expect(loadServerConfig({}, { host: "0.0.0.0", port: 8003 })).toEqual({
      host: "0.0.0.0",
      port: 8003,
    });
  });

  it("loads server overrides from env values", () => {
    expect(
      loadServerConfig({ HOST: "localhost", PORT: "9000" }, { host: "0.0.0.0", port: 8003 }),
    ).toEqual({
      host: "localhost",
      port: 9000,
    });
  });

  it("allows custom port bounds", () => {
    expect(
      loadServerConfig({ PORT: "0" }, { host: "127.0.0.1", port: 8003 }, { minPort: 0 }),
    ).toEqual({
      host: "127.0.0.1",
      port: 0,
    });
  });

  it("falls back to defaults for empty string env values", () => {
    expect(readIntegerEnv({ PORT: "" }, "PORT", { defaultValue: 8003 })).toBe(8003);
  });

  it("rejects integer values above the configured max", () => {
    expect(() =>
      readIntegerEnv({ PORT: "70000" }, "PORT", {
        defaultValue: 8003,
        max: 65535,
      }),
    ).toThrow(ConfigError);
  });

  it("rejects integer values below the configured min", () => {
    expect(() =>
      readIntegerEnv({ PORT: "0" }, "PORT", {
        defaultValue: 8003,
        min: 1,
      }),
    ).toThrow(ConfigError);
  });

  it("rejects non-integer env strings", () => {
    expect(() => readIntegerEnv({ PORT: "abc" }, "PORT", { defaultValue: 8003 })).toThrow(
      ConfigError,
    );
  });

  it("rejects decimal env strings instead of truncating them", () => {
    expect(() => readIntegerEnv({ PORT: "8080.5" }, "PORT", { defaultValue: 8003 })).toThrow(
      ConfigError,
    );
  });

  it("rejects non-integer defaults", () => {
    expect(() => readIntegerEnv({}, "PORT", { defaultValue: 8003.5 })).toThrow(ConfigError);
  });
});
