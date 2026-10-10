import { beforeEach, describe, expect, it, vi } from "vitest";
import { assessLegacyOwnerBootstrap } from "./legacyOwnerBootstrapAssessment.js";
import { readLegacyOwnerBootstrapSources } from "./legacyOwnerBootstrapSourceReader.js";
import { readLegacyOwnerBootstrapTargets } from "./legacyOwnerBootstrapTargetReader.js";
import { parseProductionMigrationCohort } from "./productionMigrationCohort.js";
import { VAY_1350_INVENTORY_REVISION } from "./sourceExtraction.js";
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
const cohort = (pmsHotelIds = Array.from({ length: 8 }, (_, i) => id(i + 20))) =>
  parseProductionMigrationCohort({
    sourceRunId: `vay1351-${"a".repeat(24)}`,
    bookingHotelIds: pmsHotelIds,
    pmsHotelIds,
    marketplaceHotelIds: [],
    approvalProofSha256: "f".repeat(64),
  });
const input = () => ({
  cohort: cohort(),
  source: {
    sourceRunId: `vay1351-${"a".repeat(24)}`,
    sourceEnvironment: "preprod",
    sourceSchemaRevision: VAY_1350_INVENTORY_REVISION,
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
    source().map((o) => ({
      ownerId: o.ownerId,
      target: "absent",
      providerUserId: null,
      providerEmailMatches: null,
    })),
  );
});
describe("combined non-executable assessment", () => {
  it("binds the owners to the run's approved cohort before any read (VAY-1362 P19)", async () => {
    const hotels = cohort().pmsHotelIds;
    for (const mismatch of [
      // A cohort hotel without its owner pair, and a pair outside the cohort.
      (data: ReturnType<typeof input>) => {
        data.cohort = cohort(hotels.slice(1));
      },
      (data: ReturnType<typeof input>) => {
        data.cohort = cohort([...hotels.slice(1), id(99)]);
      },
      // The ID sets no longer match the checksum, or only the checksum is wrong.
      (data: ReturnType<typeof input>) => {
        data.cohort.pmsHotelIds = hotels.slice(1);
      },
      (data: ReturnType<typeof input>) => {
        data.cohort.cohortSha256 = "0".repeat(64);
      },
      (data: ReturnType<typeof input>) => {
        data.cohort.sourceRunId = `vay1351-${"b".repeat(24)}`;
      },
    ]) {
      const f = fixture();
      const data = input();
      mismatch(data);
      expect(await f.run(data)).toEqual({
        outcome: "blocked",
        reason: "cohort_mismatch",
        owners: [],
        executable: false,
      });
      expect(f.a.connect).not.toHaveBeenCalled();
      expect(f.b.connect).not.toHaveBeenCalled();
    }
    // A three-hotel wave: three owner pairs, three diagnoses.
    const f = fixture();
    const data = input();
    data.source.owners = data.source.owners.slice(0, 3);
    data.cohort = cohort(data.source.owners.map((owner) => owner.hotelId));
    vi.mocked(readLegacyOwnerBootstrapSources).mockResolvedValue(source().slice(0, 3));
    vi.mocked(readLegacyOwnerBootstrapTargets).mockResolvedValue(
      source()
        .slice(0, 3)
        .map((o) => ({
          ownerId: o.ownerId,
          target: "absent",
          providerUserId: null,
          providerEmailMatches: null,
        })),
    );
    const result = await f.run(data);
    expect(result).toMatchObject({ outcome: "proposed", executable: false });
    expect(result.owners).toHaveLength(3);
  });
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
        .map((o) => ({
          ownerId: o.ownerId,
          target: "exact",
          providerUserId: "user_" + o.ownerId.replaceAll("-", ""),
          providerEmailMatches: true,
        })),
    );
    f.workos.userManagement.getUserByExternalId.mockImplementation(async (ownerId) => ({
      id: "user_" + ownerId.replaceAll("-", ""),
      externalId: ownerId,
      email: source().find((owner) => owner.ownerId === ownerId)!.email,
    }));
    f.workos.userManagement.listUsers.mockImplementation(async ({ email }: { email: string }) => {
      const owner = source().find((candidate) => candidate.email === email)!;
      return {
        data: [
          {
            id: "user_" + owner.ownerId.replaceAll("-", ""),
            externalId: owner.ownerId,
            email,
          },
        ],
        listMetadata: { after: null },
      };
    });
    const result = await f.run();
    expect(result.owners.every((o) => o.nextStep === "verify_existing_identity")).toBe(true);
    expect(result.executable).toBe(false);
  });
  it.each(["stale_target_binding", "provider_email_mismatch", "reused_target_binding"])(
    "blocks %s identity confusion",
    async (mode) => {
      const f = fixture();
      const target = source().map((owner) => ({
        ownerId: owner.ownerId,
        target: "exact" as const,
        providerUserId: "user_" + owner.ownerId.replaceAll("-", ""),
        providerEmailMatches: true,
      }));
      if (mode === "stale_target_binding") target[0]!.providerUserId = "user_stale";
      if (mode === "reused_target_binding") target[1]!.providerUserId = target[0]!.providerUserId;
      vi.mocked(readLegacyOwnerBootstrapTargets).mockResolvedValue(target);
      f.workos.userManagement.getUserByExternalId.mockImplementation(async (ownerId) => ({
        id: "user_" + ownerId.replaceAll("-", ""),
        externalId: ownerId,
        email:
          mode === "provider_email_mismatch" && ownerId === source()[0]!.ownerId
            ? "different@example.invalid"
            : source().find((owner) => owner.ownerId === ownerId)!.email,
      }));
      f.workos.userManagement.listUsers.mockImplementation(async ({ email }: { email: string }) => {
        const owner = source().find((candidate) => candidate.email === email)!;
        if (mode === "provider_email_mismatch" && owner.ownerId === source()[0]!.ownerId)
          return { data: [], listMetadata: { after: null } };
        return {
          data: [
            {
              id: "user_" + owner.ownerId.replaceAll("-", ""),
              externalId: owner.ownerId,
              email,
            },
          ],
          listMetadata: { after: null },
        };
      });
      const result = await f.run();
      expect(result.outcome).toBe("blocked");
      expect(result.owners.some((owner) => owner.outcome === "blocked")).toBe(true);
    },
  );
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
