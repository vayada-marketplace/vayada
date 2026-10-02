import { expect, it, vi } from "vitest";
import { createHotelSetupCredentialResolver } from "./hotelSetupCommandCredentials.js";
const propertyId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const databaseLogin = "vayada_next_hotel_setup_property_launch_test";
const assignment = { databaseLogin, propertyId, organizationId, operation: "launch_settings" };
function fixture(rows = [assignment]) {
  const query = vi.fn().mockResolvedValue({ rows });
  const get = vi.fn().mockResolvedValue({ username: databaseLogin, password: "p".repeat(48) });
  return {
    query,
    get,
    resolve: createHotelSetupCredentialResolver(
      {
        assignments: { query },
        vault: { get },
        databaseEndpoint: "postgresql://db.example.test/target",
        secretPrefix: "hotel-setup-command/prod/property/",
      },
      "launch_settings",
    ),
  };
}
it("selects only assigned launch credentials on each request", async () => {
  const f = fixture();
  const url = new URL(await f.resolve(propertyId, organizationId));
  expect(url.username).toBe(databaseLogin);
  expect(url.searchParams.get("sslmode")).toBe("verify-full");
  expect(f.query.mock.calls[0]?.[1]).toEqual([propertyId, organizationId, "launch_settings"]);
  expect(f.get).toHaveBeenCalledWith("hotel-setup-command/prod/property/" + databaseLogin);
  f.query.mockResolvedValue({ rows: [] });
  await expect(f.resolve(propertyId, organizationId)).rejects.toThrow(
    "Missing hotel setup assignment",
  );
  expect(f.get).toHaveBeenCalledOnce();
});
it.each([
  [],
  [assignment, assignment],
  [{ ...assignment, propertyId: organizationId }],
  [{ ...assignment, organizationId: propertyId }],
  [{ ...assignment, operation: "currency_ready" }],
  [{ ...assignment, operation: "feature_hub" }],
  [{ ...assignment, databaseLogin: "vayada_next_api_runtime" }],
])(
  "rejects absent, ambiguous or cross-purpose assignments before fetching secrets: %j",
  async (...rows) => {
    const f = fixture(rows);
    await expect(f.resolve(propertyId, organizationId)).rejects.toThrow(
      "Missing hotel setup assignment",
    );
    expect(f.get).not.toHaveBeenCalled();
  },
);
