import { beforeEach, expect, it, vi } from "vitest";
import { createAdminTransferCoordinator } from "./adminTransferCoordinator.js";

const mocks = vi.hoisted(() => ({
  resolveOwner: vi.fn(),
  resolveCommand: vi.fn(),
  prepare: vi.fn(),
  transfer: vi.fn(),
}));
vi.mock("@vayada/backend-auth", () => ({
  resolveAdminTransferSource: mocks.resolveOwner,
  resolveAdminTransferCommandSource: mocks.resolveCommand,
  prepareAdminTransferProof: mocks.prepare,
  runAdminTransfer: mocks.transfer,
}));

const source = {
  organizationId: "organization",
  actorUserId: "actor-user",
  workosUserId: "workos-user",
  workosOrgId: "workos-organization",
  sessionId: "source-session",
};
const resolved = { ...source, actorMembershipId: "actor-membership" };
const binding = {
  ...resolved,
  targetMembershipId: "target-membership",
  requestDigest: "a".repeat(64),
};
const reauthentication = { start: vi.fn(), complete: vi.fn() };
const coordinator = createAdminTransferCoordinator({ pool: {} as never, reauthentication });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveOwner.mockResolvedValue(resolved);
  mocks.resolveCommand.mockResolvedValue(resolved);
  mocks.prepare.mockResolvedValue({
    outcome: "prepared",
    proofId: "proof",
    state: "state",
    binding,
  });
  mocks.transfer.mockResolvedValue({ outcome: "transferred" });
  reauthentication.start.mockResolvedValue({
    authorizationUrl: "https://workos.test",
    flowCookie: "flow",
  });
  reauthentication.complete.mockResolvedValue({ proofId: "proof", binding });
});

it("binds preparation, hosted reauthentication, and transfer to the current owner", async () => {
  await expect(coordinator.start(source, { request: true }, "owner@example.test")).resolves.toEqual(
    {
      outcome: "prepared",
      authorizationUrl: "https://workos.test",
      flowCookie: "flow",
    },
  );
  expect(reauthentication.start).toHaveBeenCalledWith(binding, "state", "owner@example.test");
  await expect(
    coordinator.completeReauthentication({
      source,
      flowCookie: "flow",
      state: "state",
      code: "code",
    }),
  ).resolves.toEqual({ proofId: "proof", binding });
  await expect(coordinator.transfer(source, { request: true }, "proof")).resolves.toEqual({
    outcome: "transferred",
  });
  expect(mocks.transfer).toHaveBeenCalledWith({}, resolved, { request: true }, "proof");
});

it("fails closed when the live session no longer resolves to the owner", async () => {
  mocks.resolveOwner.mockResolvedValue(null);
  mocks.resolveCommand.mockResolvedValue(null);
  await expect(coordinator.start(source, {}, "owner@example.test")).resolves.toEqual({
    outcome: "rejected",
    reason: "forbidden",
  });
  await expect(
    coordinator.completeReauthentication({
      source,
      flowCookie: "flow",
      state: "state",
      code: "code",
    }),
  ).resolves.toBeNull();
  await expect(coordinator.transfer(source, {}, "proof")).resolves.toEqual({
    outcome: "rejected",
    reason: "forbidden",
  });
  expect(reauthentication.start).not.toHaveBeenCalled();
  expect(reauthentication.complete).not.toHaveBeenCalled();
  expect(mocks.transfer).not.toHaveBeenCalled();
});

it("allows a demoted source membership to receive its completed transfer receipt", async () => {
  mocks.resolveOwner.mockResolvedValue(null);
  mocks.resolveCommand.mockResolvedValue(resolved);
  await expect(coordinator.transfer(source, { request: true }, "proof")).resolves.toEqual({
    outcome: "transferred",
  });
  expect(mocks.transfer).toHaveBeenCalledWith({}, resolved, { request: true }, "proof");
});
