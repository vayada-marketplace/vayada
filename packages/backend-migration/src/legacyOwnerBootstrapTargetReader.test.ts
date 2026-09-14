import { describe, expect, it, vi } from "vitest";
import type { AdoptionQueryClient } from "./channexAdoptionTargetRows.js";
import { readLegacyOwnerBootstrapTargets } from "./legacyOwnerBootstrapTargetReader.js";
const owners = Array.from({ length: 8 }, (_, i) => ({
  ownerId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
  email: `owner${i}@example.invalid`,
}));
const rows = () =>
  owners.map((owner) => ({
    ownerId: owner.ownerId,
    candidateCount: 0,
    exactCount: 0,
    restricted: false,
    identityConflict: false,
  }));
const client = (query: unknown) => ({ query }) as AdoptionQueryClient;
describe("scoped target read boundary", () => {
  it.each(["missing", "duplicate_id", "duplicate_email", "invalid_email", "invalid_id"])(
    "rejects %s before SQL",
    async (mode) => {
      const input = structuredClone(owners),
        query = vi.fn();
      if (mode === "missing") input.pop();
      if (mode === "duplicate_id") input[1]!.ownerId = input[0]!.ownerId;
      if (mode === "duplicate_email") input[1]!.email = input[0]!.email.toUpperCase();
      if (mode === "invalid_email") input[0]!.email = "";
      if (mode === "invalid_id") input[0]!.ownerId = "invalid";
      await expect(readLegacyOwnerBootstrapTargets(client(query), input)).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    },
  );
  it("rejects writable sessions before identity reads", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ transaction_read_only: "off" }] });
    await expect(readLegacyOwnerBootstrapTargets(client(query), owners)).rejects.toThrow(
      "OWNER_TARGET_READ_FAILED",
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("copies scope before await and only returns sanitized observations", async () => {
    const input = structuredClone(owners);
    const query = vi
      .fn()
      .mockImplementationOnce(async () => {
        input[0]!.email = "changed@example.invalid";
        input[0]!.ownerId = "changed";
        return { rows: [{ transaction_read_only: "on" }] };
      })
      .mockResolvedValueOnce({ rows: rows() });
    const result = await readLegacyOwnerBootstrapTargets(client(query), input);
    expect(query.mock.calls[1]![1].slice(0, 2)).toEqual([
      owners.map((o) => o.ownerId),
      owners.map((o) => o.email),
    ]);
    expect(result.every((row) => row.target === "absent")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("@");
  });
  it.each(["missing", "duplicate", "invalid_count"])("rejects %s output", async (mode) => {
    const output = rows();
    if (mode === "missing") output.pop();
    if (mode === "duplicate") output[1] = output[0]!;
    if (mode === "invalid_count") output[0]!.candidateCount = -1;
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ transaction_read_only: "on" }] })
      .mockResolvedValueOnce({ rows: output });
    await expect(readLegacyOwnerBootstrapTargets(client(query), owners)).rejects.toThrow(
      "OWNER_TARGET_READ_FAILED",
    );
  });
  it("does not propagate raw database errors", async () => {
    const query = vi.fn().mockRejectedValue(new Error("private@example.invalid"));
    await expect(readLegacyOwnerBootstrapTargets(client(query), owners)).rejects.toThrow(
      /^OWNER_TARGET_READ_FAILED$/,
    );
  });
});
