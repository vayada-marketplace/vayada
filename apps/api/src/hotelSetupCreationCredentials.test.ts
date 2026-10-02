import { expect, it, vi } from "vitest";
import { createHotelSetupCreationCredentialResolver } from "./hotelSetupCommandCredentials.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const login = "vayada_next_hotel_setup_org_test";
function fixture(
  rows: unknown[] = [{ organizationId, databaseLogin: login }],
  secret: unknown = { username: login, password: "synthetic-fixture-password-32-bytes" },
) {
  const query = vi.fn().mockResolvedValue({ rows });
  const get = vi.fn().mockResolvedValue(secret);
  const resolve = createHotelSetupCreationCredentialResolver({
    assignments: { query },
    vault: { get },
    databaseEndpoint: "postgresql://database.internal/target",
    secretPrefix: "hotel-setup-command/prod/organization/",
  });
  return { query, get, resolve };
}

it("uses only the matching database-owned organization assignment and vault password", async () => {
  const f = fixture();
  const connection = new URL(await f.resolve(organizationId));
  expect(connection.username).toBe(login);
  expect(connection.search).toBe("?sslmode=verify-full");
  expect(f.get).toHaveBeenCalledWith("hotel-setup-command/prod/organization/" + login);
  expect(f.query.mock.calls[0]![1]).toEqual([organizationId]);
  expect(f.query.mock.calls[0]![0]).toContain("organization.status='active'");
  expect(f.query.mock.calls[0]![0]).toContain("organization.kind='hotel_group'");
});

it.each(
  [
    [],
    [{ organizationId: "22222222-2222-4222-8222-222222222222", databaseLogin: login }],
    [{ organizationId, databaseLogin: "postgres" }],
    [{ organizationId, databaseLogin: "vayada_next_hotel_setup_property_test" }],
    [{ organizationId, databaseLogin: login + "x".repeat(64) }],
    [
      { organizationId, databaseLogin: login },
      { organizationId, databaseLogin: login + "_other" },
    ],
  ].map((rows) => ({ rows })),
)(
  "rejects missing, cross-organization or ambiguous assignments before vault access",
  async ({ rows }) => {
    const f = fixture(rows);
    await expect(f.resolve(organizationId)).rejects.toThrow(
      "Missing hotel setup creation assignment",
    );
    expect(f.get).not.toHaveBeenCalled();
  },
);

it.each([
  null,
  { username: "postgres", password: "x".repeat(32) },
  { username: login, password: "short" },
  { username: login, password: "x".repeat(32), url: "postgresql://untrusted" },
])("rejects mismatched or malformed vault credentials", async (secret) => {
  const f = fixture(undefined, secret);
  await expect(f.resolve(organizationId)).rejects.toThrow("Invalid hotel setup credential");
});
