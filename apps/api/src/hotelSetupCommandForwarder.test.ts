import { describe, expect, it } from "vitest";
import { loadHotelSetupCommandForwarder } from "./hotelSetupCommandForwarder.js";

const token = "internal-token-with-at-least-32-bytes";
describe("private setup forwarding configuration", () => {
  it("stays disabled without configuration", () => {
    expect(loadHotelSetupCommandForwarder({})).toBeUndefined();
  });
  it.each([
    { HOTEL_SETUP_COMMAND_ORIGIN: "https://setup.internal" },
    { HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: token },
    {
      HOTEL_SETUP_COMMAND_ORIGIN: "https://setup.internal/path",
      HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: token,
    },
    {
      HOTEL_SETUP_COMMAND_ORIGIN: "https://user:password@setup.internal",
      HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: token,
    },
    {
      HOTEL_SETUP_COMMAND_ORIGIN: "https://setup.internal?redirect=x",
      HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: token,
    },
    {
      HOTEL_SETUP_COMMAND_ORIGIN: "https://setup.internal#fragment",
      HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: token,
    },
    {
      HOTEL_SETUP_COMMAND_ORIGIN: "http://setup.internal",
      HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: token,
    },
    {
      HOTEL_SETUP_COMMAND_ORIGIN: "https://setup.internal",
      HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: "short",
    },
  ])("rejects partial or unsafe configuration", (env) => {
    expect(() => loadHotelSetupCommandForwarder(env)).toThrow();
  });
  it("allows isolated loopback testing without changing production defaults", () => {
    expect(
      loadHotelSetupCommandForwarder({
        HOTEL_SETUP_COMMAND_ORIGIN: "http://127.0.0.1:8005",
        HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: token,
      }),
    ).toBeTypeOf("function");
  });
});
