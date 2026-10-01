import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("rejects mismatched or unsafe native configuration without exposing credentials", () => {
  const executable = new URL("./hotelSetupPropertyPreflight.ts", import.meta.url);
  const login = "vayada_next_hotel_setup_property_test";
  const env = {
    HOTEL_SETUP_COMMAND_DATABASE_LOGIN: login,
    HOTEL_SETUP_COMMAND_DATABASE_URL: `postgresql://${login}:${"p".repeat(32)}@127.0.0.1/target?sslmode=verify-full`,
    HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT: "postgresql://127.0.0.1/target",
    HOTEL_SETUP_COMMAND_OPERATION: "currency_ready",
  };
  for (const overrides of [
    { HOTEL_SETUP_COMMAND_DATABASE_URL: "postgresql://reader:synthetic-secret@[invalid/target" },
    { HOTEL_SETUP_COMMAND_DATABASE_LOGIN: "postgres" },
    { HOTEL_SETUP_COMMAND_DATABASE_LOGIN: login + "x".repeat(64) },
    { HOTEL_SETUP_COMMAND_OPERATION: "activate" },
    { HOTEL_SETUP_COMMAND_DATABASE_LOGIN: login + "x" },
    {
      HOTEL_SETUP_COMMAND_DATABASE_URL: env.HOTEL_SETUP_COMMAND_DATABASE_URL.replace(
        "verify-full",
        "require",
      ),
    },
    { HOTEL_SETUP_COMMAND_DATABASE_ENDPOINT: "postgresql://127.0.0.1/other" },
  ]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", executable.pathname], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, ...env, ...overrides },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      '{"status":"FAIL","code":"hotel_setup_property_preflight_failed"}\n',
    );
  }
});
