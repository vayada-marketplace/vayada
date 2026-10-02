import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  assertHotelSetupServiceReader,
  loadHotelSetupCommandServiceConfig,
} from "./hotelSetupCommandServiceConfig.js";

const env = {
  HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: "i".repeat(32),
  HOTEL_SETUP_COMMAND_READER_DATABASE_URL: `postgresql://vayada_next_hotel_setup_reader:${"p".repeat(32)}@db.internal/target?sslmode=verify-full`,
  HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT: "postgresql://db.internal/target",
  HOTEL_SETUP_COMMAND_SECRET_PREFIX: "vayada/hotel-setup/",
  HOTEL_SETUP_COMMAND_WORKOS_JWKS_URL: "https://api.workos.com/jwks",
  HOTEL_SETUP_COMMAND_WORKOS_ISSUER: "https://api.workos.com/",
  HOTEL_SETUP_COMMAND_WORKOS_AUDIENCE: "client_test",
};

describe("private hotel setup configuration", () => {
  it("loads only the dedicated service environment", () => {
    expect(loadHotelSetupCommandServiceConfig(env)).toMatchObject({
      host: "0.0.0.0",
      port: 8011,
      readerDatabaseUrl: env.HOTEL_SETUP_COMMAND_READER_DATABASE_URL,
    });
    expect(() =>
      loadHotelSetupCommandServiceConfig({
        TARGET_DATABASE_URL: "postgresql://postgres@db/target",
      }),
    ).toThrow("HOTEL_SETUP_COMMAND_INTERNAL_TOKEN is required");
    for (const key of Object.keys(env)) {
      expect(() => loadHotelSetupCommandServiceConfig({ ...env, [key]: "" })).toThrow();
    }
  });

  it.each([
    env.HOTEL_SETUP_COMMAND_READER_DATABASE_URL.replace(
      "vayada_next_hotel_setup_reader",
      "postgres",
    ),
    env.HOTEL_SETUP_COMMAND_READER_DATABASE_URL.replace(
      "vayada_next_hotel_setup_reader",
      "vayada_next_hotel_setup_property_a",
    ),
    env.HOTEL_SETUP_COMMAND_READER_DATABASE_URL.replace("verify-full", "require"),
    env.HOTEL_SETUP_COMMAND_READER_DATABASE_URL + "&options=-c%20role=postgres",
    env.HOTEL_SETUP_COMMAND_READER_DATABASE_URL + "&sslmode=disable",
    env.HOTEL_SETUP_COMMAND_READER_DATABASE_URL.replace("db.internal", "other.internal"),
    env.HOTEL_SETUP_COMMAND_READER_DATABASE_URL.replace("/target", "/other"),
    env.HOTEL_SETUP_COMMAND_READER_DATABASE_URL.replace(":" + "p".repeat(32) + "@", ":short@"),
  ])("rejects an unsafe reader URL", (readerDatabaseUrl) => {
    expect(() =>
      loadHotelSetupCommandServiceConfig({
        ...env,
        HOTEL_SETUP_COMMAND_READER_DATABASE_URL: readerDatabaseUrl,
      }),
    ).toThrow("Invalid hotel setup reader database configuration");
  });

  it.each([
    { HOTEL_SETUP_COMMAND_INTERNAL_TOKEN: "short" },
    { HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT: "postgresql://user:password@db.internal/target" },
    { HOTEL_SETUP_COMMAND_SECRET_PREFIX: "vayada/../" },
    { HOTEL_SETUP_COMMAND_WORKOS_JWKS_URL: "http://api.workos.com/jwks" },
    { HOTEL_SETUP_COMMAND_WORKOS_ISSUER: "https://user:password@api.workos.com/" },
  ])("rejects unsafe trust-boundary configuration", (override) => {
    expect(() => loadHotelSetupCommandServiceConfig({ ...env, ...override })).toThrow();
  });

  it("pins creation mode to its separate reader login", () => {
    const creation = {
      ...env,
      HOTEL_SETUP_COMMAND_MODE: "property_creation",
      HOTEL_SETUP_COMMAND_READER_DATABASE_URL: env.HOTEL_SETUP_COMMAND_READER_DATABASE_URL.replace(
        "vayada_next_hotel_setup_reader",
        "vayada_next_hotel_setup_creation_reader",
      ),
    };
    expect(loadHotelSetupCommandServiceConfig(creation).mode).toBe("property_creation");
    expect(() =>
      loadHotelSetupCommandServiceConfig({ ...env, HOTEL_SETUP_COMMAND_MODE: "property_creation" }),
    ).toThrow();
    expect(() =>
      loadHotelSetupCommandServiceConfig({
        ...creation,
        HOTEL_SETUP_COMMAND_MODE: "property_commands",
      }),
    ).toThrow();
    expect(() =>
      loadHotelSetupCommandServiceConfig({ ...env, HOTEL_SETUP_COMMAND_MODE: "unknown" }),
    ).toThrow();
  });

  it("does not expose malformed endpoint input in startup diagnostics", () => {
    let failure: unknown;
    try {
      loadHotelSetupCommandServiceConfig({
        ...env,
        HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT:
          "postgresql://reader:synthetic-secret@[invalid/target",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(inspect(failure)).not.toContain("synthetic-secret");
    expect(failure).not.toHaveProperty("input");
    expect(failure).not.toHaveProperty("cause");
  });

  it("requires a positive live role-posture result and propagates database failure", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ safe: true }] });
    await expect(assertHotelSetupServiceReader({ query })).resolves.toBeUndefined();
    for (const rows of [
      [],
      [{ safe: false }],
      [{ safe: "true" }],
      [{ safe: true }, { safe: true }],
    ]) {
      query.mockResolvedValue({ rows });
      await expect(assertHotelSetupServiceReader({ query })).rejects.toThrow("preflight failed");
    }
    query.mockRejectedValue(new Error("database unavailable"));
    await expect(assertHotelSetupServiceReader({ query })).rejects.toThrow("database unavailable");
  });
});
