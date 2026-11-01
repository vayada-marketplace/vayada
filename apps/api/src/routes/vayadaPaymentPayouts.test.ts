import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vayadaPayNow, vayadaPayoutCutoff } from "../domains/vayadaPaymentPayouts.js";
import { registerVayadaPaymentPayoutRoutes } from "./vayadaPaymentPayouts.js";

const USER_ID = "20000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "30000000-0000-4000-8000-000000000001";
const PAYOUT_ID = "40000000-0000-4000-8000-000000000001";
const COMMAND_ID = "50000000-0000-4000-8000-000000000001";
const DESTINATION_ID = "60000000-0000-4000-8000-000000000001";
// Monday 9 November 2026: stays checked out by Sunday the 8th are paid.
const MONDAY = new Date("2026-11-09T08:00:00Z");

function repository() {
  return {
    list: vi.fn(async () => []),
    detail: vi.fn(async () => null),
    start: vi.fn(async () => ({ status: "started" as const, payoutId: PAYOUT_ID })),
    markSent: vi.fn(async () => ({ status: "sent" as const })),
    markReturned: vi.fn(async () => ({ status: "returned" as const })),
    revealDestination: vi.fn(async () => ({ status: "not_found" as const })),
  };
}

async function testApp(repo: ReturnType<typeof repository>, permissions?: string[]) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid") return;
    request.authContext = {
      actor: {
        internalUserId: USER_ID,
        providerIdentity: { provider: "workos", providerUserId: "workos-user" },
        email: "finance@example.com",
        status: "active",
      },
      selectedOrganization: {
        organizationId: "10000000-0000-4000-8000-000000000001",
        kind: "platform",
        status: "active",
      },
      membership: {
        membershipId: "membership-1",
        status: "active",
        roleKey: "platform_admin",
        workosRoleSlugs: ["platform_admin"],
        permissions: permissions ?? ["platform.finance.read", "platform.finance.manage"],
      },
      linkedResources: [
        {
          product: "platform",
          resourceType: "platform",
          resourceId: "vayada",
          relationship: "operator",
          status: "active",
        },
      ],
      entitlements: [
        {
          product: "platform",
          key: "finance-admin",
          status: "active",
          resource: { product: "platform", resourceType: "platform", resourceId: "vayada" },
        },
      ],
      locale: "en",
      currency: "EUR",
      audit: {
        requestId: "request-1",
        correlationId: "correlation-1",
        source: "admin",
        receivedAt: "2026-11-09T08:00:00.000Z",
      },
    } as never;
  });
  await app.register(registerVayadaPaymentPayoutRoutes, {
    prefix: "/api",
    repository: repo as never,
    now: () => MONDAY,
  });
  return app;
}

const headers = { authorization: "Bearer valid" };
const payout = (overrides: Record<string, unknown> = {}) => ({
  commandId: COMMAND_ID,
  mode: "test",
  currency: "IDR",
  cutoff: "2026-11-08",
  amountMinor: "100000000",
  destinationId: DESTINATION_ID,
  ...overrides,
});

describe("vayada Payment payouts for Vayada staff (VAY-2442 P5)", () => {
  let app: Awaited<ReturnType<typeof testApp>> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("pays on Mondays for stays checked out by the Sunday before, rupiah in whole rupiah", () => {
    expect(vayadaPayoutCutoff(MONDAY)).toBe("2026-11-08");
    expect(vayadaPayoutCutoff(new Date("2026-11-08T23:59:00Z"))).toBe("2026-11-01");
    expect(vayadaPayoutCutoff(new Date("2026-11-14T00:00:00Z"))).toBe("2026-11-08");
    expect(vayadaPayNow("IDR", 100_000_050n)).toBe(100_000_000n);
    expect(vayadaPayNow("EUR", 12_345n)).toBe(12_345n);
    expect(vayadaPayNow("LKR", -500n)).toBe(0n);
  });

  it("lists live money by default and test-mode money only when asked", async () => {
    const repo = repository();
    app = await testApp(repo);
    const live = await app.inject({ url: "/api/finance/platform/vayada-payment/payouts", headers });
    expect(live.json()).toEqual({ mode: "live", cutoff: "2026-11-08", hotels: [] });
    await app.inject({ url: "/api/finance/platform/vayada-payment/payouts?mode=test", headers });
    expect(repo.list.mock.calls).toEqual([
      [{ livemode: true, cutoff: "2026-11-08" }],
      [{ livemode: false, cutoff: "2026-11-08" }],
    ]);
    const bad = await app.inject({
      url: "/api/finance/platform/vayada-payment/payouts?mode=sandbox",
      headers,
    });
    expect(bad.statusCode).toBe(400);
  });

  it("needs Platform Finance; paying and bank details need manage", async () => {
    const repo = repository();
    app = await testApp(repo, ["platform.finance.read"]);
    const url = `/api/finance/platform/vayada-payment/payouts/${PROPERTY_ID}`;
    expect(
      (await app.inject({ url: "/api/finance/platform/vayada-payment/payouts" })).statusCode,
    ).toBe(401);
    expect((await app.inject({ url, headers })).statusCode).toBe(404);
    for (const [path, payload] of [
      [url, payout()],
      [`${url}/destination/reveal`, {}],
      [`${url}/${PAYOUT_ID}/sent`, { reference: "WISE-1", paidOn: "2026-11-09" }],
      [`${url}/${PAYOUT_ID}/returned`, { commandId: COMMAND_ID, reason: "Bounced" }],
    ] as const)
      expect((await app.inject({ method: "POST", url: path, headers, payload })).statusCode).toBe(
        403,
      );
    expect(repo.start).not.toHaveBeenCalled();
    expect(repo.markSent).not.toHaveBeenCalled();
    expect(repo.revealDestination).not.toHaveBeenCalled();
  });

  it("starts a payout for this week's cut-off only, to the account shown, as the operator", async () => {
    const repo = repository();
    app = await testApp(repo);
    const url = `/api/finance/platform/vayada-payment/payouts/${PROPERTY_ID}`;
    const created = await app.inject({ method: "POST", url, headers, payload: payout() });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ payoutId: PAYOUT_ID });
    expect(repo.start).toHaveBeenCalledWith({
      propertyId: PROPERTY_ID,
      commandId: COMMAND_ID,
      livemode: false,
      currency: "IDR",
      cutoff: "2026-11-08",
      amountMinor: "100000000",
      destinationId: DESTINATION_ID,
      actorId: USER_ID,
    });
    // A page opened before the new week shows last week's amount.
    const stale = await app.inject({
      method: "POST",
      url,
      headers,
      payload: payout({ cutoff: "2026-11-01" }),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "payout_cutoff_changed", cutoff: "2026-11-08" });
    for (const bad of [
      { amountMinor: "0" },
      { amountMinor: 100 },
      { amountMinor: "-5" },
      { currency: "idr" },
      { destinationId: undefined },
      { commandId: "nope" },
      { mode: "sandbox" },
    ])
      expect(
        (await app.inject({ method: "POST", url, headers, payload: payout(bad) })).statusCode,
      ).toBe(400);
    expect(repo.start).toHaveBeenCalledTimes(1);
  });

  it("answers a changed balance, account or a busy hotel instead of starting", async () => {
    const repo = repository();
    repo.start
      .mockResolvedValueOnce({ status: "amount_changed", payNowMinor: "90000000" } as never)
      .mockResolvedValueOnce({ status: "destination_changed" } as never)
      .mockResolvedValueOnce({ status: "busy" } as never);
    app = await testApp(repo);
    const send = () =>
      app!.inject({
        method: "POST",
        url: `/api/finance/platform/vayada-payment/payouts/${PROPERTY_ID}`,
        headers,
        payload: payout(),
      });
    expect((await send()).json()).toMatchObject({
      code: "payout_amount_changed",
      payNowMinor: "90000000",
    });
    expect((await send()).json()).toMatchObject({ code: "payout_destination_changed" });
    expect((await send()).json()).toMatchObject({ code: "payout_busy" });
  });

  it("marks a payout sent with its reference, never dated in the future", async () => {
    const repo = repository();
    app = await testApp(repo);
    const url = `/api/finance/platform/vayada-payment/payouts/${PROPERTY_ID}/${PAYOUT_ID}/sent`;
    const sent = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { reference: "  WISE-123  ", paidOn: "2026-11-09" },
    });
    expect(sent.json()).toEqual({ sent: true });
    expect(repo.markSent).toHaveBeenCalledWith({
      propertyId: PROPERTY_ID,
      payoutId: PAYOUT_ID,
      reference: "WISE-123",
      paidOn: "2026-11-09",
      actorId: USER_ID,
    });
    for (const bad of [
      { reference: " ", paidOn: "2026-11-09" },
      { reference: "WISE-1", paidOn: "2026-02-30" },
      { reference: "WISE-1", paidOn: "2062-11-09" },
    ])
      expect((await app.inject({ method: "POST", url, headers, payload: bad })).statusCode).toBe(
        400,
      );
    expect(repo.markSent).toHaveBeenCalledTimes(1);
  });

  it("marks a payout returned, and shows only the expected bank details, never cached", async () => {
    const repo = repository();
    repo.revealDestination
      .mockResolvedValueOnce({
        status: "revealed",
        destinationId: DESTINATION_ID,
        countryCode: "ID",
        details: { accountHolder: "PT Hotel", accountNumber: "0123456789", bankName: "BCA" },
      } as never)
      .mockResolvedValueOnce({ status: "destination_changed" } as never)
      .mockResolvedValueOnce({ status: "unavailable" } as never);
    app = await testApp(repo);
    const base = `/api/finance/platform/vayada-payment/payouts/${PROPERTY_ID}`;
    const returned = await app.inject({
      method: "POST",
      url: `${base}/${PAYOUT_ID}/returned`,
      headers,
      payload: { commandId: COMMAND_ID, reason: "Account closed" },
    });
    expect(returned.json()).toEqual({ returned: true });
    expect(repo.markReturned).toHaveBeenCalledWith({
      propertyId: PROPERTY_ID,
      payoutId: PAYOUT_ID,
      commandId: COMMAND_ID,
      reason: "Account closed",
      actorId: USER_ID,
    });
    const reveal = () =>
      app!.inject({
        method: "POST",
        url: `${base}/destination/reveal`,
        headers,
        payload: { destinationId: DESTINATION_ID },
      });
    const details = await reveal();
    expect(details.headers["cache-control"]).toBe("no-store");
    expect(details.json()).toEqual({
      destinationId: DESTINATION_ID,
      countryCode: "ID",
      accountHolder: "PT Hotel",
      accountNumber: "0123456789",
      bankName: "BCA",
    });
    expect(repo.revealDestination).toHaveBeenCalledWith(PROPERTY_ID, USER_ID, DESTINATION_ID);
    expect((await reveal()).json()).toMatchObject({ code: "payout_destination_changed" });
    expect((await reveal()).statusCode).toBe(503);
  });
});
