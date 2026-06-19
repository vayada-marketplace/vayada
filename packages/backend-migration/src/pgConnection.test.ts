import { describe, expect, it } from "vitest";

import { normalizePgConnectionString } from "./pgConnection.js";

describe("normalizePgConnectionString", () => {
  it("preserves ordinary connection strings", () => {
    const input = "postgresql://user:pass@localhost:5432/db";

    expect(normalizePgConnectionString(input)).toBe(input);
  });

  it("adds libpq compatibility for sslmode=require", () => {
    expect(
      normalizePgConnectionString("postgresql://user:pass@localhost:5432/db?sslmode=require"),
    ).toBe("postgresql://user:pass@localhost:5432/db?sslmode=require&uselibpqcompat=true");
  });

  it("does not overwrite an explicit libpq compatibility setting", () => {
    const input = "postgresql://user:pass@localhost:5432/db?sslmode=require&uselibpqcompat=false";

    expect(normalizePgConnectionString(input)).toBe(input);
  });
});
