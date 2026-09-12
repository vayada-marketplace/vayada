import { expect, it, vi } from "vitest";
import { createChannexAirbnbBindingResolver } from "./channexAirbnbBinding.js";
const id = "10090000-0000-4000-8000-000000000001";
const groupId = "10090000-0000-4000-8000-000000000002";
const scope = { propertyId: id, organizationId: id, actorUserId: id };
const evidence = {
  contractVersion: "channex-property-creation.v1",
  environment: "staging",
  externalPropertyId: id,
  jobId: id,
};
const row = { external_property_id: id, evidence };
const payload = {
  data: {
    type: "property",
    id,
    relationships: { groups: { data: [{ type: "group", id: groupId }] } },
  },
};
function setup(rows: unknown[] = [row], body: unknown = payload) {
  const query = vi.fn().mockResolvedValue({ rows });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body));
  const resolve = createChannexAirbnbBindingResolver({
    database: { query },
    environment: "staging",
    apiKey: "synthetic",
    fetcher,
  });
  return { resolve, query, fetcher };
}
it("resolves only the directly created property and rechecks the active claim", async () => {
  const { resolve, query, fetcher } = setup();
  expect(await resolve(scope)).toEqual({ environment: "staging", externalPropertyId: id, groupId });
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[0]![1]).toEqual([id]);
  expect(query.mock.calls[0]![0]).toContain("b.claim_state='active'");
  expect(fetcher).toHaveBeenCalledWith(
    `https://staging.channex.io/api/v1/properties/${id}`,
    expect.objectContaining({ method: "GET", redirect: "error" }),
  );
});
it.each(
  [
    [],
    [{ ...row, evidence: null }],
    [{ ...row, external_property_id: groupId }],
    [{ ...row, evidence: { ...evidence, environment: "production" } }],
    [{ ...row, evidence: { ...evidence, contractVersion: "unknown" } }],
  ].map((rows) => ({ rows })),
)("rejects missing or mismatched provenance before provider access: %j", async ({ rows }) => {
  const { resolve, fetcher } = setup(rows);
  expect(await resolve(scope)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  { data: { ...payload.data, id: groupId } },
  { data: { ...payload.data, relationships: {} } },
  { data: { ...payload.data, relationships: { groups: { data: [] } } } },
  {
    data: {
      ...payload.data,
      relationships: {
        groups: {
          data: [
            { type: "group", id },
            { type: "group", id: groupId },
          ],
        },
      },
    },
  },
])("rejects mismatched property or ambiguous groups: %j", async (body) => {
  expect(await setup([row], body).resolve(scope)).toBeNull();
});
it("rejects a connection disconnected during the provider read", async () => {
  const { resolve, query } = setup();
  query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] });
  expect(await resolve(scope)).toBeNull();
});
it("sanitizes provider failures", async () => {
  const { resolve, fetcher } = setup();
  fetcher.mockRejectedValue(new Error("secret-provider-response"));
  await expect(resolve(scope)).rejects.toThrow("Airbnb property binding could not be verified");
});
it("rejects replacement evidence during the provider read", async () => {
  const { resolve, query } = setup();
  query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({
    rows: [{ ...row, evidence: { ...evidence, jobId: groupId } }],
  });
  expect(await resolve(scope)).toBeNull();
});
it("rejects an oversized provider response", async () => {
  const { resolve, fetcher } = setup();
  fetcher.mockResolvedValue(Response.json({ padding: "x".repeat(262144) }));
  await expect(resolve(scope)).rejects.toThrow("Airbnb property binding could not be verified");
});
it("uses the production origin only with production evidence", async () => {
  const query = vi.fn().mockResolvedValue({
    rows: [{ ...row, evidence: { ...evidence, environment: "production" } }],
  });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
  const resolve = createChannexAirbnbBindingResolver({
    database: { query },
    environment: "production",
    apiKey: "synthetic",
    fetcher,
  });
  expect(await resolve(scope)).toEqual({
    environment: "production",
    externalPropertyId: id,
    groupId,
  });
  expect(fetcher.mock.calls[0]![0]).toBe(`https://app.channex.io/api/v1/properties/${id}`);
});
