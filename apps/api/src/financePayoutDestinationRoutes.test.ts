import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { loadConfig, vayadaPaymentOpenFor } from "./config.js";
import { registerFinancePayoutDestinationRoutes } from "./routes/financePayoutDestination.js";

const propertyId = "24420000-0000-4000-8000-000000000002";
const resource = { product: "pms", resourceType: "pms_property", resourceId: propertyId } as const;
const details = {
  accountHolder: "PT Private Holder",
  accountNumber: "0123456789",
  bankName: "Private Bank Indonesia",
  bankCode: "014",
  branchCode: "",
  bicSwift: "CENAIDJA",
  holderAddress: "Jl. Private 1, Ubud",
};
const body = {
  action: "replace",
  commandId: "24420000-0000-4000-8000-000000000003",
  expectedVersion: 0,
  countryCode: "ID",
  details,
};
const summary = {
  id: body.commandId,
  propertyId,
  revision: 1,
  version: 1,
  enabled: true,
  deleted: false,
  accountLast4: "6789",
  countryCode: "ID",
};
const path = `/api/finance/properties/${propertyId}/payout-destination`;

async function appFor(variant: string) {
  const repository = {
    read: vi.fn(async () => summary),
    execute: vi.fn(async () => ({ status: "applied" as const, summary })),
  };
  const publisher = { publish: vi.fn(async () => null) };
  const app = Fastify();
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (variant === "missing") return;
    request.authContext = {
      actor: { internalUserId: "24420000-0000-4000-8000-000000000004", status: "active" },
      selectedOrganization: { organizationId: "org", kind: "hotel_group", status: "active" },
      membership: {
        roleKey: variant === "manager" ? "agency_manager" : "hotel_owner",
        status: "active",
        permissions:
          variant === "permission"
            ? []
            : [
                "pms.finance.read",
                "pms.operations.manage",
                "booking.settings.manage",
                ...(variant === "manager" ? [] : ["finance.billing.manage"]),
              ],
      },
      linkedResources: [
        {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: propertyId,
          relationship: "owner",
          status: "active",
        },
        { ...resource, relationship: "owner", status: "active" },
      ],
      entitlements: [{ product: "pms", key: "property-management", status: "active", resource }],
      audit: { requestId: "request", receivedAt: "2026-10-31T00:00:00Z" },
    } as RequestContext;
  });
  await app.register(registerFinancePayoutDestinationRoutes, {
    prefix: "/api",
    repository,
    // "unlisted": an owner whose hotel isn't on VAYADA_PAYMENT_PROPERTY_IDS.
    open: (id: string) => variant !== "unlisted" && id === propertyId,
    propertyAccessRepository: {
      findMembershipPropertyScope: async () => ({
        mode: "assigned",
        roleKey: variant === "manager" ? "agency_manager" : "hotel_owner",
        accessOrigin: "agency",
        assignedPropertyIds: [propertyId],
      }),
    },
    publicBookabilityPublisher: publisher,
  });
  return { app, repository, publisher };
}

it.each([
  ["missing", 401, 401],
  ["permission", 403, 403],
  ["manager", 200, 403],
  ["owner", 200, 200],
] as const)(
  "%s: reads masked with finance access, writes only as the owner",
  async (variant, readStatus, writeStatus) => {
    const { app, repository, publisher } = await appFor(variant);
    try {
      const read = await app.inject({ method: "GET", url: path });
      expect(read.statusCode).toBe(readStatus);
      const write = await app.inject({ method: "PUT", url: path, payload: body });
      expect(write.statusCode).toBe(writeStatus);
      expect(repository.execute).toHaveBeenCalledTimes(writeStatus === 200 ? 1 : 0);
      expect(publisher.publish).toHaveBeenCalledTimes(writeStatus === 200 ? 1 : 0);
      for (const response of [read, write]) {
        expect(response.headers["cache-control"]).toBe("no-store");
        for (const secret of Object.values(details).filter(Boolean))
          expect(response.body).not.toContain(secret);
        if (response.statusCode === 200)
          expect(response.json().destination).toEqual({
            id: summary.id,
            revision: 1,
            version: 1,
            enabled: true,
            deleted: false,
            countryCode: "ID",
            maskedAccount: "•••• 6789",
          });
      }
      if (writeStatus === 200)
        expect(repository.execute).toHaveBeenCalledWith({
          ...body,
          propertyId,
          actorId: "24420000-0000-4000-8000-000000000004",
        });
    } finally {
      await app.close();
    }
  },
);

it("refuses bad input, reports conflicts and hides failures", async () => {
  const { app, repository, publisher } = await appFor("owner");
  try {
    for (const payload of [
      { ...body, countryCode: "id" },
      { ...body, details: { ...details, accountHolder: "" } },
      { ...body, details: { ...details, extra: "secret" } },
      { action: "delete", commandId: body.commandId, expectedVersion: 0 },
      { action: "disable", commandId: body.commandId, expectedVersion: 1 },
    ]) {
      const response = await app.inject({ method: "PUT", url: path, payload });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain(details.accountNumber);
    }
    expect(repository.execute).not.toHaveBeenCalled();

    repository.execute.mockResolvedValueOnce({ status: "conflict" } as never);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: path,
          payload: { action: "delete", commandId: body.commandId, expectedVersion: 1 },
        })
      ).json(),
    ).toEqual({ code: "destination_conflict" });
    repository.execute.mockRejectedValueOnce(new Error(details.accountNumber));
    const failed = await app.inject({ method: "PUT", url: path, payload: body });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ code: "payout_destination_unavailable" });
    expect(publisher.publish).not.toHaveBeenCalled();

    repository.read.mockResolvedValueOnce({ ...summary, propertyId: body.commandId });
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(503);
    repository.read.mockResolvedValueOnce({ ...summary, deleted: true, enabled: false });
    expect((await app.inject({ method: "GET", url: path })).json().destination.maskedAccount).toBe(
      null,
    );
  } finally {
    await app.close();
  }
});

it("answers only for the hotels vayada Payment is on for", async () => {
  const { app, repository, publisher } = await appFor("unlisted");
  try {
    for (const method of ["GET", "PUT"] as const) {
      const response = await app.inject({
        method,
        url: path,
        ...(method === "PUT" ? { payload: body } : {}),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ code: "vayada_payment_unavailable" });
    }
    expect(repository.read).not.toHaveBeenCalled();
    expect(repository.execute).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it("opens vayada Payment only for the hotels on VAYADA_PAYMENT_PROPERTY_IDS while it is on", () => {
  const listed = "103a5fe7-05a4-4bf2-8a75-67a9ceaf9f21";
  const keys = {
    VAYADA_PAYMENT_STRIPE_SECRET_KEY: "sk_test_vay2442list",
    VAYADA_PAYMENT_STRIPE_PUBLISHABLE_KEY: "pk_test_vay2442list",
  };
  expect(loadConfig({}).vayadaPaymentPropertyIds).toEqual([]);
  const config = loadConfig({
    ...keys,
    VAYADA_PAYMENT_ENABLED: "true",
    VAYADA_PAYMENT_PROPERTY_IDS: listed.toUpperCase(),
  });
  expect(config.vayadaPaymentPropertyIds).toEqual([listed]);
  const open = vayadaPaymentOpenFor(config);
  expect([open(listed), open(listed.toUpperCase()), open(propertyId)]).toEqual([true, true, false]);
  // The list alone opens nothing; the switch with an empty list opens no hotel; without the
  // Stripe keys (every charge would fail) no hotel can be set up either.
  expect(
    vayadaPaymentOpenFor(loadConfig({ ...keys, VAYADA_PAYMENT_PROPERTY_IDS: listed }))(listed),
  ).toBe(false);
  expect(
    vayadaPaymentOpenFor(loadConfig({ ...keys, VAYADA_PAYMENT_ENABLED: "true" }))(listed),
  ).toBe(false);
  expect(
    vayadaPaymentOpenFor(
      loadConfig({ VAYADA_PAYMENT_ENABLED: "true", VAYADA_PAYMENT_PROPERTY_IDS: listed }),
    )(listed),
  ).toBe(false);
  // "*": every hotel (for the launch).
  const all = loadConfig({
    ...keys,
    VAYADA_PAYMENT_ENABLED: "true",
    VAYADA_PAYMENT_PROPERTY_IDS: "*",
  });
  expect(all.vayadaPaymentPropertyIds).toBe("all");
  expect(vayadaPaymentOpenFor(all)(propertyId)).toBe(true);
  expect(() => loadConfig({ VAYADA_PAYMENT_PROPERTY_IDS: "not-a-property" })).toThrow(
    "VAYADA_PAYMENT_PROPERTY_IDS requires up to 100 property UUIDs",
  );
});

it("keeps vayada Payment off unless VAYADA_PAYMENT_ENABLED is set", () => {
  expect(loadConfig({}).vayadaPaymentEnabled).toBe(false);
  expect(loadConfig({ VAYADA_PAYMENT_ENABLED: "true" }).vayadaPaymentEnabled).toBe(true);
  expect(() => loadConfig({ VAYADA_PAYMENT_ENABLED: "maybe" })).toThrow(
    "VAYADA_PAYMENT_ENABLED must be true or false",
  );
});
