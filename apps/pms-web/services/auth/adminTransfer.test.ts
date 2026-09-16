import { beforeEach, expect, it, vi } from "vitest";

vi.mock("./sessionStore", () => ({ getAuthCsrfToken: () => "csrf-token" }));

import {
  completePendingAdminTransfer,
  startAdminTransfer,
  type AdminTransferRequest,
} from "./adminTransfer";

const transfer: AdminTransferRequest = {
  targetMembershipId: "11111111-1111-4111-8111-111111111111",
  expectedActorRevision: "a".repeat(64),
  expectedTargetRevision: "b".repeat(64),
  formerAdmin: {
    roleDefinitionId: "22222222-2222-4222-8222-222222222222",
    expectedRoleRevision: "2",
    propertyAccessMode: "all",
    propertyIds: [],
    permissionOverrides: { grant: [], deny: [] },
    productAccess: { pms: true, booking: true },
  },
};

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal("window", { location: { assign: vi.fn() }, sessionStorage });
  vi.stubGlobal("fetch", vi.fn());
});

it("persists the exact request before redirecting to hosted verification", async () => {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ authorizationUrl: "https://auth.workos.test/verify" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

  await startAdminTransfer(transfer);

  expect(fetch).toHaveBeenCalledWith(
    "/auth/admin-transfer/start",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "x-vayada-csrf": "csrf-token" }),
      body: JSON.stringify({ transfer }),
    }),
  );
  expect(sessionStorage.getItem("vayada.pending-admin-transfer.v1")).toBe(JSON.stringify(transfer));
  expect(window.location.assign).toHaveBeenCalledWith("https://auth.workos.test/verify");
});

it("retains the request after an uncertain completion and clears it after receipt replay", async () => {
  sessionStorage.setItem("vayada.pending-admin-transfer.v1", JSON.stringify(transfer));
  vi.mocked(fetch)
    .mockRejectedValueOnce(new Error("connection lost"))
    .mockResolvedValueOnce(
      new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ outcome: "idempotent_replay" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

  await expect(completePendingAdminTransfer()).rejects.toThrow("connection lost");
  expect(sessionStorage.getItem("vayada.pending-admin-transfer.v1")).toBeTruthy();
  await expect(completePendingAdminTransfer()).rejects.toThrow();
  expect(sessionStorage.getItem("vayada.pending-admin-transfer.v1")).toBeTruthy();
  await expect(completePendingAdminTransfer()).resolves.toBe("idempotent_replay");
  expect(sessionStorage.getItem("vayada.pending-admin-transfer.v1")).toBeNull();
});
