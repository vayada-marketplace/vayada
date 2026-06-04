import { describe, expect, it } from "vitest";

import { createDatabase } from "./index.js";

describe("backend-db", () => {
  it("rejects an empty connection string", () => {
    expect(() => createDatabase({ connectionString: " " })).toThrow(
      "Invalid DatabaseConfig.connectionString",
    );
  });

  it("rejects an invalid pool max", () => {
    expect(() =>
      createDatabase({
        connectionString: "postgres://user:pass@example.test:5432/db",
        max: 0,
      }),
    ).toThrow("Invalid DatabaseConfig.max");
  });

  it("creates a client for valid config without connecting immediately", async () => {
    const db = createDatabase({
      connectionString: "postgres://user:pass@example.test:5432/db",
      max: 1,
    });

    await db.destroy();
  });
});
