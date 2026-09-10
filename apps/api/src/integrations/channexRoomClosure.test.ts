import { describe, expect, it, vi } from "vitest";
import type { ChannexManagementConfig } from "../config.js";
import type { DistributionBookingPublicationTransaction } from "../domains/distributionBookingPublicationProjection.js";
import { verifyChannexRoomClosure } from "./channexRoomClosure.js";

const scope = {
  propertyId: "property",
  roomTypeId: "room",
  from: "2026-09-09",
  through: "2026-09-10",
};
const config: ChannexManagementConfig = {
  apiBaseUrl: "https://staging.channex.io",
  apiKey: "test-only",
  workerEnabled: false,
  stagingRestrictionsPropertyId: scope.propertyId,
  bookingMutationOwner: "target",
  capabilityModes: {
    connection: "mutating",
    provisioning: "mutating",
    ariSync: "mutating",
    bookingSync: "observe_only",
    markups: "observe_only",
    messaging: "observe_only",
    iframe: "observe_only",
  },
};
function fixture(
  options: {
    locked?: boolean;
    jobs?: boolean;
    disconnected?: boolean;
    channel?: string;
    mismatchedRoom?: boolean;
    missingDay?: boolean;
    availability?: unknown;
    stopSell?: unknown;
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
    const rows = sql.includes("pg_try_advisory")
      ? [{ locked: options.locked ?? true }]
      : sql.includes("FROM pms.channel_connections")
        ? options.disconnected
          ? []
          : [
              {
                id: "connection",
                provider: "channex",
                status: "connected",
                externalId: "external-property",
              },
            ]
        : sql.includes("FROM pms.channel_room_type_mappings")
          ? options.disconnected
            ? []
            : [
                {
                  kind: "room",
                  connectionId: "connection",
                  externalId: "external-room",
                  externalRoomId: "external-room",
                  channel: "direct",
                },
                {
                  kind: "rate",
                  connectionId: "connection",
                  externalId: "external-rate",
                  externalRoomId: options.mismatchedRoom ? "another-room" : "external-room",
                  channel: options.channel ?? "direct",
                },
              ]
          : sql.includes("FROM pms.channel_binding_claims")
            ? [{ id: "claim" }]
            : sql.includes("FROM platform.jobs")
              ? options.jobs
                ? [{ id: "job" }]
                : []
              : [];
    return { rows, rowCount: rows.length };
  });
  const fetcher = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
    if (String(url).includes("/rate_plans?"))
      return Response.json({
        data: [
          {
            id: "external-rate",
            relationships: {
              property: { data: { id: "external-property" } },
              room_type: { data: { id: "external-room" } },
            },
          },
        ],
        meta: { total: 1 },
      });
    if (String(url).includes("/channels?")) return Response.json({ data: [], meta: { total: 0 } });
    const availability = String(url).includes("/availability?");
    const dates: Record<string, unknown> = {};
    for (const date of options.missingDay ? [scope.from] : [scope.from, scope.through])
      dates[date] = availability
        ? (options.availability ?? 0)
        : { stop_sell: options.stopSell ?? true };
    return Response.json({ data: { [availability ? "external-room" : "external-rate"]: dates } });
  });
  return {
    client: { query } as unknown as DistributionBookingPublicationTransaction,
    query,
    fetcher,
  };
}

describe("paused Channex room closure readback", () => {
  it("reads every mapped date under provider coordination and checks queue before and after", async () => {
    const test = fixture();
    await verifyChannexRoomClosure(test.client, config, scope, test.fetcher);
    expect(test.fetcher).toHaveBeenCalledTimes(4);
    expect(
      test.query.mock.calls.filter(([sql]) => sql.includes("FROM platform.jobs")),
    ).toHaveLength(2);
    const [url, request] = test.fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe("https://staging.channex.io");
    expect(url.searchParams.get("filter[property_id]")).toBe("external-property");
    expect(request.redirect).toBe("error");
    expect(request.method).toBeUndefined();
  });
  it.each([
    [{ locked: false }, "operation_in_flight"],
    [{ jobs: true }, "queue_not_empty"],
    [{ channel: "booking_com" }, "mapping_unsupported"],
    [{ mismatchedRoom: true }, "mapping_unsupported"],
  ] as const)("rejects prerequisite %j without provider calls", async (options, error) => {
    const test = fixture(options);
    await expect(
      verifyChannexRoomClosure(test.client, config, scope, test.fetcher),
    ).rejects.toThrow(error);
    expect(test.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { workerEnabled: true },
    { stagingRestrictionsPropertyId: "another" },
    { apiBaseUrl: "https://app.channex.io" },
    { apiKey: undefined },
    { capabilityModes: { ...config.capabilityModes, bookingSync: "mutating" as const } },
  ])("rejects unsupported runtime %j", async (override) => {
    const test = fixture();
    await expect(
      verifyChannexRoomClosure(test.client, { ...config, ...override }, scope, test.fetcher),
    ).rejects.toThrow("mode_unsupported");
    expect(test.fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { missingDay: true },
    { availability: 1 },
    { availability: "0" },
    { stopSell: false },
    { stopSell: "true" },
  ])("rejects incomplete or open readback %j", async (options) => {
    const test = fixture(options);
    await expect(
      verifyChannexRoomClosure(test.client, config, scope, test.fetcher),
    ).rejects.toThrow("provider_not_closed_zero");
  });
  it("sanitizes provider transport errors", async () => {
    const test = fixture();
    test.fetcher.mockRejectedValueOnce(new Error("private provider details"));
    await expect(
      verifyChannexRoomClosure(test.client, config, scope, test.fetcher),
    ).rejects.toThrow("channex_closure_readback_failed");
  });
  it("allows unconnected rooms without provider requests", async () => {
    const test = fixture({ disconnected: true });
    await verifyChannexRoomClosure(
      test.client,
      { ...config, apiKey: undefined },
      scope,
      test.fetcher,
    );
    expect(test.fetcher).not.toHaveBeenCalled();
  });
});
