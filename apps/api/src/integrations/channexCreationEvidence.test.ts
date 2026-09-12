import { expect, it, vi } from "vitest";
import { createChannexManagementProvider, channexRequests } from "./channexManagement.js";
import { applyPmsChannexManagementProgress } from "../jobs/pmsChannexManagementTargetState.js";
import type { ChannexManagementJob } from "../jobs/pmsChannexManagementWorker.js";
const id = "10090000-0000-4000-8000-000000000001";
const job = {
  jobId: id,
  propertyId: id,
  input: { operationType: "enable" },
} as ChannexManagementJob;
async function run(
  status = 201,
  origin = "https://staging.channex.io",
  recovered = false,
  externalId = id,
) {
  const checkpoint = vi.fn();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json(
      {
        data: recovered ? [{ id: externalId, attributes: { title: "Hotel" } }] : { id: externalId },
      },
      { status },
    ),
  );
  const provider = createChannexManagementProvider({
    apiBaseUrl: origin,
    apiKey: "synthetic",
    fetch: fetcher,
    plans: {
      plan: async () => ({
        requests: recovered
          ? [channexRequests.findProperty("Hotel")]
          : [channexRequests.createProperty({ title: "Hotel" })],
        checkpoint,
      }),
    },
  });
  return { result: await provider.execute(job), checkpoint, fetcher };
}
it("carries direct creation evidence through checkpoint and final result", async () => {
  const { result, checkpoint, fetcher } = await run();
  const proof = { environment: "staging", externalPropertyId: id };
  expect(result).toMatchObject({ ok: true, createdProperty: proof });
  expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ createdProperty: proof }));
  expect(fetcher.mock.calls[0]![1]?.redirect).toBe("manual");
});
it("records the configured official production environment", async () => {
  expect((await run(201, "https://app.channex.io")).result).toMatchObject({
    createdProperty: { environment: "production" },
  });
});
it.each([
  [200, "https://staging.channex.io", false, id],
  [200, "https://staging.channex.io", true, id],
  [201, "https://other.example.test", false, id],
  [201, "https://staging.channex.io", false, "invalid-id"],
] as const)(
  "does not certify ambiguous or recovered properties (%s,%s,%s,%s)",
  async (status, origin, recovered, externalId) => {
    const { result, checkpoint } = await run(status, origin, recovered, externalId);
    expect(result).not.toHaveProperty("createdProperty");
    for (const call of checkpoint.mock.calls) expect(call[0]).not.toHaveProperty("createdProperty");
  },
);
it("stores evidence only on the matching connection after the claim is established", async () => {
  const query = vi.fn(async () => ({ rows: [{ id }], rowCount: 1 }));
  await applyPmsChannexManagementProgress(
    { query } as never,
    job,
    {
      ok: true,
      externalPropertyId: id,
      createdProperty: { environment: "staging", externalPropertyId: id },
    },
    new Date(),
  );
  const calls = query.mock.calls as unknown as [string, unknown[]][];
  const proof = calls.find(([sql]) => sql.includes("jsonb_set"))!;
  expect(calls.findIndex(([sql]) => sql.includes("channel_binding_claims"))).toBeLessThan(
    calls.indexOf(proof),
  );
  expect(proof[0]).toContain("external_property_id=$2");
  expect(proof[1]).toEqual([
    id,
    id,
    JSON.stringify({
      contractVersion: "channex-property-creation.v1",
      environment: "staging",
      externalPropertyId: id,
      jobId: id,
    }),
  ]);
});
it("clears evidence on disconnect", async () => {
  const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
  await applyPmsChannexManagementProgress(
    { query } as never,
    { ...job, input: { operationType: "disable" } } as ChannexManagementJob,
    { ok: true, connectionStatus: "disconnected" },
    new Date(),
  );
  expect(JSON.stringify(query.mock.calls)).toContain("- 'airbnbCreationEvidence'");
});
