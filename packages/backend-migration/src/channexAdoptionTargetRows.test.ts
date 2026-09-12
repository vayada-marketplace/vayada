import { describe, expect, it, vi } from "vitest";

import { hashTargetRow } from "./channexAdoptionManifestCrypto.js";
import { readAdoptionTargetRow } from "./channexAdoptionTargetRows.js";

describe("Channex adoption target row evidence", () => {
  it("hashes every physical non-generated column using PostgreSQL-normalized values", async () => {
    const id = "19630000-0000-4000-8000-000000000001";
    const row = {
      id,
      created_at: "2026-09-12T10:30:00.123456Z",
      revision: "7",
      enabled: true,
      labels: ["one", "two"],
      metadata: { nested: "value" },
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          { columnName: "id", dataType: "uuid", udtName: "uuid" },
          {
            columnName: "created_at",
            dataType: "timestamp with time zone",
            udtName: "timestamptz",
          },
          { columnName: "revision", dataType: "bigint", udtName: "int8" },
          { columnName: "enabled", dataType: "boolean", udtName: "bool" },
          { columnName: "labels", dataType: "ARRAY", udtName: "_text" },
          { columnName: "metadata", dataType: "jsonb", udtName: "jsonb" },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ ...row, metadata: '{"nested": "value"}' }] });

    await expect(
      readAdoptionTargetRow({ query } as never, "hotel_catalog.properties", id),
    ).resolves.toEqual({
      id,
      rowStateSha256: hashTargetRow({
        schema: "hotel_catalog",
        table: "properties",
        primaryKey: id,
        row,
      }),
    });
    expect(query.mock.calls[0]![0]).toContain("is_generated = 'NEVER'");
    expect(query.mock.calls[1]![0]).toContain("SS.US");
    expect(query.mock.calls[1]![0]).toContain('"revision"::text');
    expect(query.mock.calls[1]![0]).toContain('"metadata"::text');
  });

  it.each(["9007199254740992", "9007199254740993"])(
    "rejects lossy JSON integer %s before hashing",
    async (unsafe) => {
      const query = vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            { columnName: "id", dataType: "uuid", udtName: "uuid" },
            { columnName: "metadata", dataType: "jsonb", udtName: "jsonb" },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: "19630000-0000-4000-8000-000000000001",
              metadata: `{"value":${unsafe}}`,
            },
          ],
        });

      await expect(
        readAdoptionTargetRow(
          { query } as never,
          "hotel_catalog.properties",
          "19630000-0000-4000-8000-000000000001",
        ),
      ).rejects.toMatchObject({ code: "TARGET_JSON_NOT_IJSON" });
    },
  );

  it("rejects unsupported physical column types instead of coercing them", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{ columnName: "amount", dataType: "double precision", udtName: "float8" }],
    });
    await expect(
      readAdoptionTargetRow(
        { query } as never,
        "hotel_catalog.properties",
        "19630000-0000-4000-8000-000000000001",
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_TARGET_COLUMN" });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
