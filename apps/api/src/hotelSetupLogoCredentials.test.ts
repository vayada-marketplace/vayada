import { expect, it, vi } from "vitest";
import { createHotelSetupLogoCredentialResolver } from "./hotelSetupCommandCredentials.js";
const propertyId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const databaseLogin = "vayada_next_hotel_setup_logo_test";
const assignment = {
  databaseLogin,
  propertyId,
  organizationId,
  actorUserId: "33333333-3333-4333-8333-333333333333",
  credentialRoleOid: 12345,
  actualRoleOid: 12345,
  credentialSecretVersion: "11111111-1111-4111-8111-111111111111",
  credentialReadyAt: new Date("2026-10-04T00:00:00Z"),
};
function fixture(rows: unknown[] = [assignment]) {
  const query = vi.fn().mockResolvedValue({ rows });
  const get = vi.fn().mockResolvedValue({ username: databaseLogin, password: "p".repeat(48) });
  return {
    query,
    get,
    resolve: createHotelSetupLogoCredentialResolver({
      assignments: { query },
      readNativeSecret: get,
      databaseEndpoint: "postgresql://db.example.test/target",
      secretPrefix: "hotel-setup-command/prod/property/",
    }),
  };
}
it("selects only assigned logo credentials on each request", async () => {
  const f = fixture();
  const url = new URL(await f.resolve(propertyId, organizationId, assignment.actorUserId));
  expect(url.username).toBe(databaseLogin);
  expect(url.searchParams.get("sslmode")).toBe("verify-full");
  expect(f.query.mock.calls[0]?.[1]).toEqual([propertyId, organizationId, assignment.actorUserId]);
  expect(f.get).toHaveBeenCalledWith(
    "hotel-setup-command/prod/property/" + databaseLogin,
    "11111111-1111-4111-8111-111111111111",
  );
  f.query.mockResolvedValue({ rows: [] });
  await expect(f.resolve(propertyId, organizationId, assignment.actorUserId)).rejects.toThrow(
    "Missing hotel setup logo assignment",
  );
  expect(f.get).toHaveBeenCalledOnce();
});
it.each([
  [],
  [assignment, assignment],
  [{ ...assignment, propertyId: organizationId }],
  [{ ...assignment, organizationId: propertyId }],
  [{ ...assignment, actorUserId: propertyId }],
  [{ ...assignment, databaseLogin: "vayada_next_hotel_setup_property_test" }],
  [{ ...assignment, databaseLogin: "vayada_next_api_runtime" }],
  [{ ...assignment, credentialRoleOid: null }],
  [{ ...assignment, actualRoleOid: 12346 }],
  [{ ...assignment, credentialSecretVersion: "latest" }],
  [{ ...assignment, credentialReadyAt: null }],
])(
  "rejects absent, ambiguous or cross-purpose assignments before fetching secrets: %j",
  async (...rows) => {
    const f = fixture(rows);
    await expect(f.resolve(propertyId, organizationId, assignment.actorUserId)).rejects.toThrow(
      "Missing hotel setup logo assignment",
    );
    expect(f.get).not.toHaveBeenCalled();
  },
);
