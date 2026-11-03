import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  pools: [] as { end: ReturnType<typeof vi.fn> }[],
  decide: vi.fn(),
  schedule: vi.fn(),
  intake: vi.fn(),
  readback: vi.fn(),
}));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      end = vi.fn(async () => {});
      constructor() {
        mocks.pools.push(this);
      }
    },
  },
}));
vi.mock("./domains/channexAlterationDecisions.js", () => ({
  decideChannexAlteration: mocks.decide,
}));
vi.mock("./jobs/channexAlterationIntake.js", () => ({
  scheduleChannexAlterationScans: mocks.schedule,
  runChannexAlterationIntake: mocks.intake,
}));
vi.mock("./jobs/channexAlterations.js", () => ({ runChannexAlterationReadback: mocks.readback }));
import { createAirbnbAlterationRuntime } from "./airbnbAlterationRuntime.js";
import { loadConfig } from "./config.js";
const propertyId = "10090000-0000-4000-8000-000000000001";
const otherId = "10090000-0000-4000-8000-000000000002";
function config() {
  const base = loadConfig({});
  return {
    ...base,
    airbnbAlterations: { propertyIds: [propertyId] },
    backgroundWorkersEnabled: true,
    channexManagement: {
      ...base.channexManagement,
      workerEnabled: true,
      bookingMutationOwner: "target" as const,
      apiBaseUrl: "https://staging.channex.io",
      apiKey: "synthetic",
      capabilityModes: {
        ...base.channexManagement.capabilityModes,
        bookingSync: "mutating" as const,
      },
    },
  };
}
const input = {
  propertyId,
  bookingId: otherId,
  changeRequestId: otherId,
  actorUserId: otherId,
  action: "accept" as const,
  correlationId: "synthetic",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.pools.length = 0;
});
it("creates no pools or provider work by default", () => {
  expect(
    createAirbnbAlterationRuntime({ config: loadConfig({}), connectionString: "unused" }),
  ).toBeUndefined();
  expect(mocks.pools).toHaveLength(0);
  expect(mocks.schedule).not.toHaveBeenCalled();
});
it("composes one scope across presentation, webhook, worker and decisions", async () => {
  const runtime = createAirbnbAlterationRuntime({ config: config(), connectionString: "unused" })!;
  expect(runtime.adapter.propertyIds).toEqual([propertyId]);
  expect(runtime.webhookOptions.channexAlterationPropertyIds).toEqual([propertyId]);
  expect(runtime.bookingWorkerOptions).toEqual({
    applyAirbnbAlterations: true,
    allowUnverifiedAirbnbAlterations: true,
    airbnbAlterationPropertyIds: [propertyId],
  });
  await expect(runtime.adapter.decide({ ...input, propertyId: otherId })).rejects.toThrow(
    "alteration_runtime_unavailable",
  );
  expect(mocks.decide).not.toHaveBeenCalled();
  await runtime.adapter.decide(input);
  const ports = mocks.decide.mock.calls[0]![0];
  expect(ports.pool).not.toBe(ports.journalPool);
  expect(ports.allowUnverifiedAirbnbAlterations).toBe(true);
  await runtime.tick();
  for (const call of [mocks.schedule, mocks.intake, mocks.readback]) {
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0]![0]).toMatchObject({ propertyIds: [propertyId] });
  }
  await runtime.close();
  expect(mocks.pools.every((pool) => pool.end.mock.calls.length === 1)).toBe(true);
});
it("does not overlap batches and drains work before closing pools", async () => {
  let finish!: () => void;
  mocks.schedule.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const runtime = createAirbnbAlterationRuntime({ config: config(), connectionString: "unused" })!;
  const first = runtime.tick();
  expect(runtime.tick()).toBe(first);
  expect(mocks.schedule).toHaveBeenCalledOnce();
  const shared = mocks.schedule.mock.calls[0]![0];
  const closing = runtime.close();
  expect(shared.signal.aborted).toBe(true);
  expect(shared.ownsMutation()).toBe(false);
  expect(mocks.pools.every((pool) => pool.end.mock.calls.length === 0)).toBe(true);
  await expect(runtime.adapter.decide(input)).rejects.toThrow("alteration_runtime_unavailable");
  finish();
  await closing;
  await runtime.tick();
  expect(mocks.schedule).toHaveBeenCalledOnce();
});
it("clears a failed batch so a later scheduled scan can retry", async () => {
  mocks.schedule.mockRejectedValueOnce(new Error("database unavailable"));
  const runtime = createAirbnbAlterationRuntime({ config: config(), connectionString: "unused" })!;
  await expect(runtime.tick()).rejects.toThrow("database unavailable");
  await runtime.tick();
  expect(mocks.schedule).toHaveBeenCalledTimes(2);
  await runtime.close();
});
it("keeps decision pools open until an in-flight decision settles", async () => {
  let finish!: () => void;
  mocks.decide.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const runtime = createAirbnbAlterationRuntime({ config: config(), connectionString: "unused" })!;
  const decision = runtime.adapter.decide(input);
  const closing = runtime.close();
  await Promise.resolve();
  expect(mocks.pools.every((pool) => pool.end.mock.calls.length === 0)).toBe(true);
  finish();
  await Promise.all([decision, closing]);
  expect(mocks.pools.every((pool) => pool.end.mock.calls.length === 1)).toBe(true);
});

it("passes explicit all-hotels scope through every boundary", async () => {
  const runtime = createAirbnbAlterationRuntime({
    config: { ...config(), airbnbAlterations: { propertyIds: undefined } },
    connectionString: "unused",
  })!;
  expect(runtime.adapter.propertyIds).toBeUndefined();
  expect(runtime.webhookOptions.channexAlterationPropertyIds).toBeUndefined();
  expect(runtime.bookingWorkerOptions.airbnbAlterationPropertyIds).toBeUndefined();
  await runtime.adapter.decide({ ...input, propertyId: otherId });
  expect(mocks.decide).toHaveBeenCalledOnce();
  await runtime.tick();
  for (const call of [mocks.schedule, mocks.intake, mocks.readback])
    expect(call.mock.calls[0]![0].propertyIds).toBeUndefined();
  await runtime.close();
});
