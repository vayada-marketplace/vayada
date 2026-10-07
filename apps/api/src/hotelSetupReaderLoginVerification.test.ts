import pg from "pg";
import { expect, it, vi } from "vitest";
import { activateVerifiedHotelSetupReader } from "./hotelSetupReaderLoginVerification.js";

it("rejects untrusted role references and endpoints before opening an admin connection", async () => {
  const password = "p".repeat(36);
  const input = {
    adminDatabaseUrl: `postgresql://admin:${password}@database.example/target?sslmode=verify-full`,
    readerDatabaseUrl: `postgresql://vayada_next_hotel_setup_reader:${password}@database.example/target?sslmode=verify-full`,
    databaseEndpoint: "postgresql://database.example/target",
    expectedRoleOid: 123,
  };
  const client = vi.spyOn(pg, "Client");
  vi.stubEnv("PGUSER", "synthetic_ambient_admin");
  try {
    for (const drift of [
      { expectedRoleOid: 0 },
      { expectedRoleOid: NaN },
      { expectedRoleOid: 1.5 },
      { readerDatabaseUrl: input.readerDatabaseUrl.replace("verify-full", "require") },
      { readerDatabaseUrl: input.readerDatabaseUrl.replace("reader", "other") },
      { adminDatabaseUrl: input.adminDatabaseUrl.replace("/target", "/another") },
      { adminDatabaseUrl: input.adminDatabaseUrl.replace("database.example", "another.example") },
      { adminDatabaseUrl: input.adminDatabaseUrl + "&options=unsafe" },
      { adminDatabaseUrl: input.adminDatabaseUrl.replace("//admin:", "//:") },
    ]) {
      await expect(activateVerifiedHotelSetupReader({ ...input, ...drift })).rejects.toThrow(
        /^Hotel setup reader login verification failed$/,
      );
    }
    expect(client).not.toHaveBeenCalled();
  } finally {
    client.mockRestore();
    vi.unstubAllEnvs();
  }
});
