import { createHash } from "node:crypto";
import { AuthorizationError } from "@vayada/backend-authorization";
import { describe, expect, it, vi } from "vitest";
import { createHotelSetupActorCredentialResolver } from "./hotelSetupCommandCredentials.js";
import { writeHotelSetupPropertyProfile } from "./hotelSetupProfileCommands.js";
import type { HotelSetupPropertyProfileCommand } from "./routes/sharedHotelSetupStatus.js";

const propertyId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "33333333-3333-4333-8333-333333333333";
const scope = { propertyId, organizationId, actorUserId };
const row = {
  propertyId,
  profileRevision: 3,
  displayName: "Old",
  propertyType: "hotel",
  countryCode: "LK",
  city: "Ahangama",
  streetAddress: "1 Beach Road",
  postalCode: "80650",
  timezone: "Asia/Colombo",
  latitude: null,
  longitude: null,
  localityPublic: false,
  geoPublic: false,
  mapDisplayMode: "hidden",
  contacts: [{ channelType: "email", value: "a@example.test", purpose: "guest", isPublic: true }],
};

function harness(write: unknown) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes("profile_snapshot")) return { rows: [{ value: row }] };
    if (sql.includes("update_property_profile")) {
      if (write instanceof Error) throw write;
      return { rows: [{ value: write }] };
    }
    if (sql.includes("AS safe")) return { rows: [{ safe: true }] };
    return { rows: [] };
  });
  const release = vi.fn();
  return { query, release, pool: { connect: vi.fn(async () => ({ query, release })) } };
}
type Merge = HotelSetupPropertyProfileCommand["merge"];
const command = (
  merge: Merge = (existing) => ({ expectedProfileRevision: 3, profile: existing }),
): HotelSetupPropertyProfileCommand => ({
  idempotencyKey: "save-1",
  fingerprint: "f".repeat(64),
  merge,
});
const statements = (query: ReturnType<typeof harness>["query"]) =>
  query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/).slice(0, 2).join(" "));

describe("native profile writer adapter", () => {
  it("attests, snapshots, merges and writes in one transaction with a hashed retry key", async () => {
    const h = harness({ status: "updated", profile: { ...row, profileRevision: 4 } });
    const merge = vi.fn<Merge>((existing) => ({ expectedProfileRevision: 3, profile: existing }));
    const result = await writeHotelSetupPropertyProfile(
      h.pool as never,
      scope,
      "request-1",
      command(merge),
    );
    expect(result).toMatchObject({ status: "updated", profile: { profileRevision: 4 } });
    expect(merge.mock.calls[0]![0]).toMatchObject({ displayName: "Old", propertyType: "hotel" });
    expect(statements(h.query)).toEqual([
      "BEGIN ISOLATION",
      "SELECT (",
      "SELECT platform.hotel_setup_property_profile_snapshot($1,$2,$3)",
      "SELECT platform.hotel_setup_update_property_profile($1,$2,$3,$4,$5,$6,$7,$8)",
      "COMMIT",
    ]);
    const values = h.query.mock.calls[3]![1] as unknown[];
    expect(values.slice(0, 4)).toEqual([propertyId, organizationId, actorUserId, 3]);
    expect(JSON.parse(values[4] as string)).toMatchObject({
      display_name: "Old",
      contacts: [
        { channel_type: "email", value: "a@example.test", purpose: "guest", is_public: true },
      ],
    });
    expect(values.slice(5)).toEqual([
      createHash("sha256").update("save-1").digest("hex"),
      "f".repeat(64),
      "request-1",
    ]);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("returns validation, conflict and replay outcomes without hiding them", async () => {
    const invalid = harness({ status: "updated" });
    expect(
      await writeHotelSetupPropertyProfile(
        invalid.pool as never,
        scope,
        "r",
        command(() => ({ fields: { displayName: ["required"] } })),
      ),
    ).toEqual({ status: "invalid", fields: { displayName: ["required"] } });
    expect(statements(invalid.query).at(-1)).toBe("ROLLBACK");
    for (const outcome of [
      { status: "conflict", currentRevision: 5 },
      { status: "idempotency_conflict" },
    ]) {
      const h = harness(outcome);
      expect(await writeHotelSetupPropertyProfile(h.pool as never, scope, "r", command())).toEqual(
        outcome,
      );
    }
    const replay = harness({ status: "replayed", profile: row });
    expect(
      await writeHotelSetupPropertyProfile(replay.pool as never, scope, "r", command()),
    ).toMatchObject({ status: "replayed", profile: { profileRevision: 3 } });
  });

  it("rolls back and denies native authority failures; other errors propagate", async () => {
    const denied = harness(Object.assign(new Error("forbidden"), { code: "42501" }));
    await expect(
      writeHotelSetupPropertyProfile(denied.pool as never, scope, "r", command()),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(statements(denied.query).at(-1)).toBe("ROLLBACK");
    const broken = harness(Object.assign(new Error("check"), { code: "23514" }));
    await expect(
      writeHotelSetupPropertyProfile(broken.pool as never, scope, "r", command()),
    ).rejects.toThrow("check");
    expect(statements(broken.query).at(-1)).toBe("ROLLBACK");
  });
});

describe("profile credential selection", () => {
  const assignment = {
    databaseLogin: "vayada_next_hotel_setup_profile_test",
    propertyId,
    organizationId,
    actorUserId,
    credentialRoleOid: 7,
    actualRoleOid: 7,
    credentialSecretVersion: "11111111-1111-4111-8111-111111111111",
    credentialReadyAt: new Date("2026-10-06T00:00:00Z"),
  };
  const resolver = (rows: unknown[]) => {
    const query = vi.fn().mockResolvedValue({ rows });
    const readNativeSecret = vi.fn().mockResolvedValue({
      username: assignment.databaseLogin,
      password: "p".repeat(48),
    });
    return {
      query,
      readNativeSecret,
      resolve: createHotelSetupActorCredentialResolver(
        {
          assignments: { query },
          readNativeSecret,
          databaseEndpoint: "postgresql://db.example.test/target",
          secretPrefix: "hotel-setup-command/prod/property/",
        },
        "property_profile",
      ),
    };
  };
  it("selects only the actor-bound profile assignment", async () => {
    const r = resolver([assignment]);
    const url = new URL(await r.resolve(propertyId, organizationId, actorUserId));
    expect(url.username).toBe(assignment.databaseLogin);
    expect(r.query.mock.calls[0]![0]).toContain("scope.operation_class='property_profile'");
    expect(r.query.mock.calls[0]![1]).toEqual([propertyId, organizationId, actorUserId]);
  });
  it.each([
    [{ ...assignment, databaseLogin: "vayada_next_hotel_setup_logo_test" }],
    [{ ...assignment, databaseLogin: "vayada_next_hotel_setup_property_test" }],
    [{ ...assignment, actorUserId: propertyId }],
    [assignment, assignment],
    [],
  ])("rejects logo, property or ambiguous assignments: %j", async (...rows) => {
    const r = resolver(rows);
    await expect(r.resolve(propertyId, organizationId, actorUserId)).rejects.toThrow(
      "Missing hotel setup profile assignment",
    );
    expect(r.readNativeSecret).not.toHaveBeenCalled();
  });
});
