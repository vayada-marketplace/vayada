import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      async connect() {
        return mocks;
      }
      async end() {}
    },
  },
}));
import { createPgPreparedImportRepository } from "./preparedHotelImportRepository.js";
describe("prepared import lock cleanup", () => {
  it.each([false, true])(
    "destroys a connection and preserves an earlier failure: %s",
    async (executionFails) => {
      mocks.query.mockReset();
      mocks.release.mockReset();
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes("pg_advisory_unlock")) throw new Error("unlock cancelled");
        if (sql.startsWith("SELECT invite"))
          return {
            rows: [
              {
                sourceId: "source",
                data: { contractVersion: "prepared-hotel-import.v1", property: {}, rooms: [] },
                results: {},
              },
            ],
          };
        return { rows: [] };
      });
      const repository = createPgPreparedImportRepository("postgresql://unused");
      await expect(
        repository.apply(
          {
            organizationId: "org",
            actorUserId: "actor",
            sourceId: "source",
            propertyId: "property",
          },
          async () => {
            if (executionFails) throw new Error("execution failed");
            return [];
          },
        ),
      ).rejects.toThrow(executionFails ? "execution failed" : "unlock cancelled");
      expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
    },
  );
});
