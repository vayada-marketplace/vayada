import type { Pool, PoolClient } from "pg";

// Identity-owned setup for the isolated affiliate probe integration test.
// These fixed synthetic rows must never be created through public signup.
const propertyId = "11880000-0000-4000-8000-000000000001";

async function assertTestDatabase(client: Pool | PoolClient): Promise<void> {
  const result = await client.query<{ name: string }>("SELECT current_database() AS name");
  if (!/(^|[_-])(test|verify)([_-]|$)/i.test(result.rows[0]?.name ?? "")) {
    throw new Error("Unsafe test database");
  }
}

export async function seedAffiliateProbeIdentity(client: Pool | PoolClient): Promise<void> {
  await assertTestDatabase(client);
  await client.query(
    "INSERT INTO identity.users(id,email) VALUES($1,'probe-binding@example.invalid')",
    [propertyId],
  );
  await client.query(
    "INSERT INTO identity.organizations(id,kind,name,slug) VALUES($1,'hotel_group','Probe binding test','probe-binding-test')",
    [propertyId],
  );
  await client.query(
    "INSERT INTO identity.organization_resource_links(organization_id,product,resource_type,resource_id,relationship) VALUES($1::uuid,'marketplace','hotel_profile',$1::uuid::text,'owner')",
    [propertyId],
  );
}

export async function cleanupAffiliateProbeIdentity(client: PoolClient): Promise<void> {
  await assertTestDatabase(client);
  for (const statement of [
    "DELETE FROM identity.organization_resource_links WHERE organization_id=$1",
    "DELETE FROM identity.organizations WHERE id=$1",
    "DELETE FROM identity.users WHERE id=$1",
  ]) {
    await client.query(statement, [propertyId]);
  }
}
