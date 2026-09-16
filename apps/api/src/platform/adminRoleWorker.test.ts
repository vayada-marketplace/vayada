import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), end: vi.fn() }));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      end = mocks.end;
    },
  },
}));
vi.mock("@vayada/backend-auth", () => ({ reconcileNextAdminRole: mocks.run }));
import { startAdminRoleWorker } from "./adminRoleWorker.js";
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("prevents overlapping polls and closes its pool after active work", async () => {
  vi.useFakeTimers();
  let release!: (value: boolean) => void;
  mocks.run
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(false);
  const worker = startAdminRoleWorker({
    connectionString: "local",
    provider: { updateRole: vi.fn() },
    warn: vi.fn(),
  });
  await vi.advanceTimersByTimeAsync(10000);
  expect(mocks.run).toHaveBeenCalledTimes(1);
  const closed = worker.close();
  expect(mocks.end).not.toHaveBeenCalled();
  release(false);
  await closed;
  expect(mocks.end).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10000);
  expect(mocks.run).toHaveBeenCalledTimes(1);
});
