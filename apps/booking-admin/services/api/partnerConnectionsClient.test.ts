import { describe, expect, it, vi } from "vitest";
import { ApiErrorResponse } from "./client";
import {
  PartnerAuthorizationRequestError,
  createPartnerConnectionsClient,
} from "./partnerConnectionsClient";

// VAY-2436: connecting a partner app once, and Settings › Connected apps.
const propertyId = "A1B2C3D4-0000-4000-8000-000000000001";
const query = new URLSearchParams({
  response_type: "code",
  client_id: "partner_abc",
  redirect_uri: "https://partner.example/callback",
  state: "s",
});

describe("partner connections client", () => {
  it("loads the approval request and sends the decision with the app's own query", async () => {
    const http = {
      get: vi.fn(async () => ({
        app: { name: "Partner" },
        scopes: ["promo_codes", "bookings"],
        properties: [{ propertyId, name: "Alpina", promoCodesEnabled: false }],
      })),
      post: vi.fn(async () => ({ redirectTo: "https://partner.example/callback?code=c&state=s" })),
      delete: vi.fn(),
    };
    const client = createPartnerConnectionsClient(http as never);
    expect(await client.loadAuthorization(query)).toEqual({
      app: { name: "Partner" },
      scopes: ["promo_codes", "bookings"],
      properties: [{ propertyId, name: "Alpina", promoCodesEnabled: false }],
    });
    expect(http.get.mock.calls[0]![0]).toBe(`/api/booking/partner-authorizations?${query}`);
    expect(await client.decide(query, "allow", propertyId)).toBe(
      "https://partner.example/callback?code=c&state=s",
    );
    expect(http.post).toHaveBeenCalledWith(
      "/api/booking/partner-authorizations",
      { authorization: Object.fromEntries(query), decision: "allow", propertyId },
      expect.anything(),
    );
  });

  it("turns a refused request into an error that says where to send the browser, if anywhere", async () => {
    const refused = (data: Record<string, unknown>) => ({
      get: vi.fn(async () => {
        throw new ApiErrorResponse(400, data);
      }),
      post: vi.fn(),
      delete: vi.fn(),
    });
    const back = createPartnerConnectionsClient(
      refused({
        code: "invalid_scope",
        redirectTo: "https://partner.example/callback?error=invalid_scope",
      }) as never,
    );
    await expect(back.loadAuthorization(query)).rejects.toMatchObject({
      code: "invalid_scope",
      redirectTo: "https://partner.example/callback?error=invalid_scope",
    });
    const shown = createPartnerConnectionsClient(refused({ code: "invalid_client" }) as never);
    const error = await shown.loadAuthorization(query).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartnerAuthorizationRequestError);
    expect(error).toMatchObject({ code: "invalid_client", redirectTo: null });
    // Only http(s) targets are followed.
    const script = createPartnerConnectionsClient(
      refused({ code: "invalid_request", redirectTo: "javascript:alert(1)" }) as never,
    );
    await expect(script.loadAuthorization(query)).rejects.toMatchObject({ redirectTo: null });
  });

  it("lists and disconnects the hotel's connected apps on its property", async () => {
    const connection = {
      connectionId: "C0000000-0000-4000-8000-000000000002",
      appName: "Partner",
      scopes: ["promo_codes"],
      approvedAt: "2026-11-20T10:00:00.000Z",
      approvedByName: null,
    };
    const http = {
      get: vi.fn(async () => ({ connections: [connection, { appName: 1 }], canManage: true })),
      post: vi.fn(),
      delete: vi.fn(async () => undefined),
    };
    const client = createPartnerConnectionsClient(http as never);
    expect(await client.list(propertyId)).toEqual({ connections: [connection], canManage: true });
    expect(http.get.mock.calls[0]![0]).toBe(
      "/api/booking/properties/a1b2c3d4-0000-4000-8000-000000000001/partner-connections",
    );
    await client.disconnect(propertyId, connection.connectionId);
    expect(http.delete).toHaveBeenCalledWith(
      "/api/booking/properties/a1b2c3d4-0000-4000-8000-000000000001/partner-connections/c0000000-0000-4000-8000-000000000002",
    );
    await expect(client.list("not-a-property")).rejects.toThrow();
  });
});
