import { describe, expect, it, vi } from "vitest";
import { listChannexAlerts } from "./channexOperationalAlerts.js";

describe("Channex alert list", () => {
  it("loads alerts with one read-only query", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    const client = { query } as unknown as Parameters<typeof listChannexAlerts>[0];
    await listChannexAlerts(client, "65f6b2fc-c783-4963-9d6b-a85f82319769");

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/^\s*SELECT\b/i);
  });
});
