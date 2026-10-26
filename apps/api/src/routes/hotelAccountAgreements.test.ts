import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ context: null as unknown, error: null as Error | null }));
vi.mock("@vayada/backend-auth", async (original) => ({
  ...(await original<typeof import("@vayada/backend-auth")>()),
  requireAuthContext: vi.fn(() => {
    if (auth.error) throw auth.error;
    return auth.context;
  }),
}));

import { UnauthorizedError } from "@vayada/backend-auth";

import type { HotelAccountAgreementsRepository } from "../domains/hotelAccountAgreementsRepository.js";
import { registerHotelAccountAgreementsRoutes } from "./hotelAccountAgreements.js";

const organizationId = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d";
const userId = "b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e";
const current = { termsVersion: "2026-10-24", dpaVersion: "2026-10-24" };
const accountName = "Alpenrose Hotels";
const accepted = {
  ...current,
  acceptedAt: "2026-10-24T09:00:00.000Z",
  acceptedBy: { name: "Anna Keller", email: "anna@example.test" },
  source: "account_admin" as const,
};

function context(
  overrides: {
    roleKey?: string;
    kind?: string;
    membershipStatus?: string;
    actorStatus?: string;
  } = {},
) {
  return {
    actor: { internalUserId: userId, status: overrides.actorStatus ?? "active" },
    selectedOrganization: {
      organizationId,
      name: "Alpenrose Hotels",
      kind: overrides.kind ?? "hotel_group",
      status: "active",
    },
    membership: {
      membershipId: "m-1",
      roleKey: overrides.roleKey ?? "hotel_owner",
      status: overrides.membershipStatus ?? "active",
    },
  };
}

async function call(
  method: "GET" | "POST",
  path: string,
  repository: Partial<HotelAccountAgreementsRepository>,
  payload?: unknown,
) {
  const app = Fastify();
  await registerHotelAccountAgreementsRoutes(app, {
    repository: repository as HotelAccountAgreementsRepository,
  });
  const response = await app.inject({
    method,
    url: path,
    ...(payload === undefined
      ? {}
      : { payload: JSON.stringify(payload), headers: { "content-type": "application/json" } }),
  });
  await app.close();
  return response;
}

beforeEach(() => {
  auth.context = context();
  auth.error = null;
});

describe("hotel account agreements routes (VAY-2246)", () => {
  it("GET shows everyone on the account the current versions and their acceptance", async () => {
    auth.context = context({ roleKey: "front_desk" });
    const findAcceptance = vi.fn(async () => accepted);
    const response = await call("GET", "/agreements", { findAcceptance });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({ current, accepted, canAccept: false, accountName });
    expect(findAcceptance).toHaveBeenCalledWith(organizationId, current);
  });

  it("GET tells the account admin they may accept while nothing is accepted", async () => {
    const response = await call("GET", "/agreements", { findAcceptance: vi.fn(async () => null) });
    expect(response.json()).toEqual({ current, accepted: null, canAccept: true, accountName });
  });

  it("refuses signed-out people, other kinds of account and inactive members", async () => {
    auth.error = new UnauthorizedError();
    expect((await call("GET", "/agreements", {})).statusCode).toBe(401);
    auth.error = null;
    for (const overrides of [
      { kind: "platform" },
      { membershipStatus: "suspended" },
      { actorStatus: "disabled" },
    ]) {
      auth.context = context(overrides);
      const response = await call("GET", "/agreements", {});
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: "forbidden" });
    }
  });

  it("POST records the account admin's acceptance of the current versions", async () => {
    const accept = vi.fn(async () => accepted);
    const findAcceptance = vi.fn(async () => accepted);
    const response = await call("POST", "/agreements/accept", { accept, findAcceptance }, current);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ current, accepted, canAccept: true, accountName });
    expect(accept).toHaveBeenCalledWith({
      organizationId,
      userId,
      source: "account_admin",
      versions: current,
    });
  });

  it("POST is for the account admin only", async () => {
    auth.context = context({ roleKey: "hotel_manager" });
    const accept = vi.fn();
    const response = await call("POST", "/agreements/accept", { accept }, current);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "account_admin_required" });
    expect(accept).not.toHaveBeenCalled();
  });

  it("POST refuses when the database no longer sees an account admin", async () => {
    const response = await call(
      "POST",
      "/agreements/accept",
      { accept: vi.fn(async () => null) },
      current,
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "account_admin_required" });
  });

  it("POST never records a version the person wasn't shown", async () => {
    const accept = vi.fn();
    const outdated = await call(
      "POST",
      "/agreements/accept",
      { accept },
      { termsVersion: "2026-10-20", dpaVersion: "2026-10-24" },
    );
    expect(outdated.statusCode).toBe(409);
    expect(outdated.json()).toEqual({ code: "agreements_outdated", current });
    for (const body of [{}, { termsVersion: "2026-10-24" }, [], "2026-10-24"]) {
      const invalid = await call("POST", "/agreements/accept", { accept }, body);
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ code: "invalid_agreements" });
    }
    expect(accept).not.toHaveBeenCalled();
  });
});
