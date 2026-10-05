import type pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { hotelSetupOrganizationConnection } from "./hotelSetupOrganizationRoleStaging.js";
import { proveFreshHotelSetupNativeCredential } from "./hotelSetupFreshNativeCredential.js";

vi.mock("./hotelSetupOrganizationRoleStaging.js", () => ({
  hotelSetupOrganizationConnection: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

it.each([
  "success",
  "session",
  "effective",
  "oid",
  "effectiveOid",
  "missing",
  "duplicate",
  "connect",
  "query",
  "proof",
  "proofErrorEvent",
  "endErrorEvent",
  "error",
  "end",
])("authenticates an exact fresh native identity on %s", async (mode) => {
  const login = "vayada_next_hotel_setup_org_c0be02f6ee4d481aadb8c7eca98d74c1";
  const input = {
    login,
    roleOid: 42,
    nativeDatabaseUrl: `postgresql://${login}:${"b".repeat(36)}@db.internal/test?sslmode=verify-full`,
    databaseEndpoint: "postgresql://db.internal/test",
  };
  let onError: (() => void) | undefined;
  const identity = {
    session_login: mode === "session" ? "other" : login,
    effective_login: mode === "effective" ? "other" : login,
    role_oid: mode === "oid" ? 43 : 42,
    effective_oid: mode === "effectiveOid" ? 43 : 42,
  };
  const end = vi.fn(async () => {
    if (mode === "endErrorEvent") onError?.();
    if (mode === "end") throw new Error();
  });
  const client = {
    on: vi.fn((_event: string, handler: () => void) => {
      onError = handler;
    }),
    connect: vi.fn(async () => {
      if (mode === "connect") throw new Error();
    }),
    query: vi.fn(async (sql: string) => {
      expect(sql).toContain("session_user::regrole::oid");
      expect(sql).toContain("current_user::regrole::oid");
      if (mode === "query") throw new Error();
      if (mode === "error") onError?.();
      return {
        rows: mode === "missing" ? [] : mode === "duplicate" ? [identity, identity] : [identity],
      };
    }),
    end,
  };
  vi.mocked(hotelSetupOrganizationConnection).mockReturnValue(client as unknown as pg.Client);
  const prove = vi.fn(async (received: pg.Client) => {
    expect(received).toBe(client);
    if (mode === "proofErrorEvent") {
      onError?.();
      throw new Error("native proof rejected");
    }
    if (mode === "proof") throw new Error();
  });
  const result = proveFreshHotelSetupNativeCredential(input, prove);
  if (mode === "success") await expect(result).resolves.toBeUndefined();
  else if (mode === "proofErrorEvent")
    await expect(result).rejects.toThrow("native proof rejected");
  else await expect(result).rejects.toThrow();
  expect(hotelSetupOrganizationConnection).toHaveBeenCalledWith(
    input.nativeDatabaseUrl,
    input.databaseEndpoint,
  );
  expect(end).toHaveBeenCalledOnce();
  if (["success", "proof", "proofErrorEvent", "endErrorEvent", "end"].includes(mode))
    expect(prove).toHaveBeenCalledOnce();
  else expect(prove).not.toHaveBeenCalled();
});

it("rejects a different URL login before constructing a native client", async () => {
  await expect(
    proveFreshHotelSetupNativeCredential({
      login: "expected",
      roleOid: 42,
      nativeDatabaseUrl: `postgresql://other:${"b".repeat(36)}@db.internal/test?sslmode=verify-full`,
      databaseEndpoint: "postgresql://db.internal/test",
    }),
  ).rejects.toThrow();
  expect(hotelSetupOrganizationConnection).not.toHaveBeenCalled();
});
