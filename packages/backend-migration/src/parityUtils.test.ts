import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import type { ParityFinding } from "./parityTypes.js";
import { checkIdStability, checkRowCounts } from "./parityUtils.js";

describe("parityUtils", () => {
  it("tags shared row-count findings with the parity harness owner", async () => {
    const findings: ParityFinding[] = [];
    const client = {
      query: vi.fn(async () => ({ rows: [{ count: "1" }] })),
    } as unknown as pg.Client;

    await checkRowCounts(
      client,
      {
        counts: { "hotel_catalog.properties": 2 },
        idStability: {},
      },
      findings,
    );

    expect(findings).toEqual([
      expect.objectContaining({
        code: "ROW_COUNT_MISMATCH",
        owner: "Parity harness",
        targetObject: "hotel_catalog.properties",
      }),
    ]);
  });

  it("tags shared ID stability findings with the parity harness owner", async () => {
    const findings: ParityFinding[] = [];
    const client = {
      query: vi.fn(async () => ({ rows: [{ exists: false }] })),
    } as unknown as pg.Client;

    await checkIdStability(
      client,
      {
        counts: {},
        idStability: { "identity.users": ["user-1"] },
      },
      findings,
    );

    expect(findings).toEqual([
      expect.objectContaining({
        code: "ID_STABILITY_VIOLATION",
        owner: "Parity harness",
        targetObject: "identity.users",
      }),
    ]);
  });
});
