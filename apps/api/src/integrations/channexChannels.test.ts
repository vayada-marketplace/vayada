import { expect, it, vi } from "vitest";
import { channexRequests, createChannexManagementProvider } from "./channexManagement.js";

const channel = (id: string, code = "Expedia") => ({
  id,
  attributes: { channel: code, properties: ["property"], is_active: false },
});
const page = (data: unknown[], number = 1, total = data.length) => ({
  data,
  meta: { page: number, limit: 1, total },
});

function provider(fetcher: typeof fetch, checkpoint = vi.fn()) {
  return {
    checkpoint,
    instance: createChannexManagementProvider({
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "synthetic",
      fetch: fetcher,
      plans: {
        plan: async () => ({ requests: [channexRequests.listChannels("property")], checkpoint }),
      },
    }),
  };
}
const job = {
  jobId: "job",
  propertyId: "property",
  correlationId: null,
  attemptNumber: 1,
  maxAttempts: 5,
  input: { commandId: "command", idempotencyKey: "key", operationType: "provision" as const },
};

it("reads the sanitized staging OpenChannel response without application", async () => {
  const { instance } = provider(
    vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          {
            id: "staging-channel",
            type: "channel",
            attributes: {
              channel: "OpenChannel",
              title: "Synthetic probe",
              currency: null,
              properties: ["property"],
              rate_plans: [],
              is_active: false,
              settings: {
                endpoint: "https://example.invalid",
                derived_option: { rate: [["increase_by_percent", "12"]] },
              },
            },
          },
        ],
        meta: { total: 1, limit: 100, order_by: "title", page: 1, order_direction: "asc" },
      }),
    ),
  );
  const result = await instance.execute(job);
  expect(result).toMatchObject({
    ok: true,
    channels: [
      {
        externalChannelId: "staging-channel",
        providerCode: "OpenChannel",
        isActive: false,
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("endpoint");
});

it("keeps same-type channel IDs distinct and checkpoints only the complete listing", async () => {
  const checkpoint = vi.fn();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(page([channel("first")], 1, 2)))
    .mockImplementationOnce(async () => {
      expect(checkpoint).not.toHaveBeenCalled();
      return Response.json(page([channel("second")], 2, 2));
    });
  const { instance } = provider(fetcher, checkpoint);
  const result = await instance.execute(job);
  expect(result).toMatchObject({
    ok: true,
    channels: [
      { externalChannelId: "first", providerCode: "Expedia", isActive: false },
      { externalChannelId: "second", providerCode: "Expedia", isActive: false },
    ],
  });
  expect(checkpoint).toHaveBeenCalledOnce();
  for (const [index, call] of fetcher.mock.calls.entries()) {
    const url = new URL(String(call[0]));
    expect(url.searchParams.get("filter[property_id]")).toBe("property");
    expect(url.searchParams.get("pagination[page]")).toBe(String(index + 1));
  }
});

it.each([
  ["HTTP failure", () => new Response(null, { status: 503 })],
  ["missing pagination", () => Response.json({ data: [] })],
  ["short page", () => Response.json(page([], 2, 2))],
  ["repeated page", () => Response.json(page([channel("second")], 1, 2))],
  ["duplicate ID", () => Response.json(page([channel("first")], 2, 2))],
  [
    "cross-property channel",
    () =>
      Response.json(
        page(
          [
            {
              id: "second",
              attributes: { channel: "Agoda", properties: ["other"], is_active: true },
            },
          ],
          2,
          2,
        ),
      ),
  ],
  ["malformed channel", () => Response.json(page([{ id: "second", attributes: {} }], 2, 2))],
  ["changed total", () => Response.json(page([channel("second")], 2, 3))],
] as const)("does not replace cached channels after %s on a later page", async (_, next) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(page([channel("first")], 1, 2)))
    .mockImplementationOnce(async () => next());
  const { instance, checkpoint } = provider(fetcher);
  expect(await instance.execute(job)).toMatchObject({ ok: false });
  expect(checkpoint).not.toHaveBeenCalled();
});

it("accepts an empty complete listing", async () => {
  const { instance } = provider(vi.fn<typeof fetch>().mockResolvedValue(Response.json(page([]))));
  expect(await instance.execute(job)).toMatchObject({ ok: true, channels: [] });
});
