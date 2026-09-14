import { beforeEach, describe, expect, it, vi } from "vitest";
import { assessLegacyOwnerBootstrap } from "./legacyOwnerBootstrapAssessment.js";
import { readLegacyOwnerBootstrapSources } from "./legacyOwnerBootstrapSourceReader.js";
import { readLegacyOwnerBootstrapTargets } from "./legacyOwnerBootstrapTargetReader.js";
vi.mock("./legacyOwnerBootstrapSourceReader.js", () => ({
  readLegacyOwnerBootstrapSources: vi.fn(),
}));
vi.mock("./legacyOwnerBootstrapTargetReader.js", () => ({
  readLegacyOwnerBootstrapTargets: vi.fn(),
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = () =>
  Array.from({ length: 8 }, (_, i) => ({
    ownerId: id(i + 1),
    email: `owner${i}@example.invalid`,
    sourceStatus: "pending",
    sourceOwnership: "matched" as const,
  }));
const input = () => ({
  source: {
    sourceRunId: `vay1351-${"a".repeat(24)}`,
    sourceEnvironment: "preprod",
    sourceSchemaRevision: "b".repeat(40),
    ledgerSha256: "c".repeat(64),
    owners: source().map((o, i) => ({
      ownerId: o.ownerId,
      hotelId: id(i + 20),
      userOrdinal: i + 1,
      hotelOrdinal: i + 1,
      userSha256: "d".repeat(64),
      hotelSha256: "e".repeat(64),
    })),
  },
  targetEnvironment: "production" as const,
  controlOrganizationId: "org_fixture",
});
const now = new Date("2026-09-14T03:00:00.000Z");
function fixture() {
  const events: string[] = [];
  const pool = (name: string) => {
    const client = {
      query: vi.fn(async (sql: string) => {
        events.push(name + ":" + sql);
        return { rows: [] };
      }),
      release: vi.fn(() => {
        events.push(name + ":released");
      }),
    };
    return { client, connect: vi.fn(async () => client) };
  };
  const a = pool("source"),
    b = pool("target");
  const workos = {
    organizations: {
      getOrganization: vi.fn(async () => {
        expect(events.at(-1)).toBe("target:released");
        return { id: "org_fixture" };
      }),
    },
    userManagement: {
      getUserByExternalId: vi.fn().mockRejectedValue({ status: 404 }),
      listUsers: vi.fn().mockResolvedValue({ data: [], listMetadata: { after: null } }),
    },
  };
  return {
    a,
    b,
    workos,
    events,
    run: (data = input(), clock = () => now) =>
      assessLegacyOwnerBootstrap(a as never, b as never, workos as never, data, clock),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readLegacyOwnerBootstrapSources).mockResolvedValue(source());
  vi.mocked(readLegacyOwnerBootstrapTargets).mockResolvedValue(
    source().map((o) => ({ ownerId: o.ownerId, target: "absent" })),
  );
});
describe("combined non-executable assessment", () => {
  it("composes all reads and closes both snapshots before scoped GETs", async () => {
    const f = fixture(),
      result = await f.run();
    expect(result.outcome).toBe("proposed");
    expect(result.executable).toBe(false);
    expect(result.owners).toHaveLength(8);
    expect(JSON.stringify(result)).not.toContain("@");
    expect(f.workos.userManagement.getUserByExternalId).toHaveBeenCalledTimes(8);
    expect(f.workos.userManagement.listUsers).toHaveBeenCalledTimes(8);
    expect(f.workos.userManagement.listUsers).toHaveBeenNthCalledWith(1, {
      email: "owner0@example.invalid",
      limit: 100,
    });
    for (const pool of [f.a, f.b]) {
      expect(pool.client.query.mock.calls.map((call) => call[0])).toEqual([
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
        "ROLLBACK",
      ]);
      expect(pool.client.release).toHaveBeenCalledWith(false);
    }
  });
  it("never treats an email-only candidate as a link", async () => {
    const f = fixture();
    f.workos.userManagement.listUsers.mockImplementation(async ({ email }: { email: string }) => ({
      data: [{ id: "user_other", email, externalId: null }],
      listMetadata: { after: null },
    }));
    const result = await f.run();
    expect(result.outcome).toBe("blocked");
    expect(result.owners.every((o) => o.outcome === "blocked")).toBe(true);
  });
  it("routes exact existing identities to verification, not access", async () => {
    const f = fixture();
    vi.mocked(readLegacyOwnerBootstrapTargets).mockResolvedValue(
      source()
        .reverse()
        .map((o) => ({ ownerId: o.ownerId, target: "exact" })),
    );
    f.workos.userManagement.getUserByExternalId.mockImplementation(async (ownerId) => ({
      id: "user_" + ownerId.replaceAll("-", ""),
      externalId: ownerId,
    }));
    const result = await f.run();
    expect(result.owners.every((o) => o.nextStep === "verify_existing_identity")).toBe(true);
    expect(result.executable).toBe(false);
  });
  it.each(["source", "target", "control", "pagination", "filter", "network", "cleanup"])(
    "fails closed for %s failure",
    async (mode) => {
      const f = fixture();
      if (mode === "source")
        vi.mocked(readLegacyOwnerBootstrapSources).mockRejectedValue(
          new Error("private@example.invalid"),
        );
      if (mode === "target")
        vi.mocked(readLegacyOwnerBootstrapTargets).mockRejectedValue(
          new Error("private@example.invalid"),
        );
      if (mode === "control")
        f.workos.organizations.getOrganization.mockResolvedValue({ id: "org_wrong" });
      if (mode === "pagination")
        f.workos.userManagement.listUsers.mockResolvedValue({
          data: [],
          listMetadata: { after: "more" },
        });
      if (mode === "filter")
        f.workos.userManagement.listUsers.mockResolvedValue({
          data: [{ id: "user_wrong", email: "wrong@example.invalid" }],
          listMetadata: { after: null },
        });
      if (mode === "network")
        f.workos.userManagement.getUserByExternalId.mockRejectedValue({ status: 500 });
      if (mode === "cleanup")
        f.a.client.query.mockRejectedValue(new Error("private@example.invalid"));
      expect(await f.run()).toEqual({
        outcome: "blocked",
        reason: "owner_assessment_failed",
        owners: [],
        executable: false,
      });
      if (mode === "cleanup") {
        expect(f.a.client.release).toHaveBeenCalledWith(true);
        expect(f.b.connect).not.toHaveBeenCalled();
      }
    },
  );
  it("skips provider user reads for already blocked owners", async () => {
    const f = fixture();
    vi.mocked(readLegacyOwnerBootstrapSources).mockResolvedValue(
      source().map((o) => ({ ...o, sourceStatus: "suspended" })),
    );
    expect((await f.run()).outcome).toBe("blocked");
    expect(f.workos.userManagement.listUsers).not.toHaveBeenCalled();
  });
  it("blocks an assessment that expires during reads", async () => {
    const f = fixture(),
      clock = vi
        .fn()
        .mockReturnValueOnce(now)
        .mockReturnValueOnce(new Date(now.getTime() + 16 * 60 * 1000));
    expect((await f.run(input(), clock)).reason).toBe("stale_or_invalid_evidence");
  });
  it("freezes the approved request before awaits", async () => {
    const f = fixture(),
      data = input(),
      before = structuredClone(data.source);
    f.a.connect.mockImplementation(async () => {
      data.source.owners[0]!.ownerId = id(99);
      data.controlOrganizationId = "org_wrong";
      return f.a.client;
    });
    expect((await f.run(data)).outcome).toBe("proposed");
    expect(readLegacyOwnerBootstrapSources).toHaveBeenCalledWith(f.a.client, before);
    expect(f.workos.organizations.getOrganization).toHaveBeenCalledWith("org_fixture");
  });
});
