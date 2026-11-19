import { AuthError, backendAuthPlugin, createWorkOSVerifier } from "@vayada/backend-auth";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  checkAuthorizationRequest,
  parseScopes,
  pkceChallenge,
  pkceMatches,
  type PartnerApp,
  type PartnerConnectionsRepository,
} from "../domains/partnerConnections.js";
import {
  checkRedirectUri,
  parsePartnerAppRegistrationArgs,
} from "../platform/partnerAppRegistration.js";
import { basicCredentials, bearerToken, registerPartnerApiRoutes } from "./partnerApi.js";

const partnerApp: PartnerApp = {
  appId: "11111111-1111-4111-8111-111111111111",
  clientId: "partner_abc",
  name: "Partner",
  redirectUris: ["https://partner.example/callback"],
  allowedScopes: ["promo_codes", "bookings"],
};

function fakeRepository(overrides: Partial<PartnerConnectionsRepository> = {}) {
  return {
    findApp: vi.fn(async () => partnerApp),
    authenticateClient: vi.fn(async (clientId: string, secret: string) =>
      clientId === "partner_abc" && secret === "s3cret" ? partnerApp : null,
    ),
    approve: vi.fn(),
    exchangeCode: vi.fn(async () => ({ error: "invalid_grant" as const })),
    refresh: vi.fn(async () => ({ error: "invalid_grant" as const })),
    revokeByPartner: vi.fn(async () => undefined),
    authenticateAccessToken: vi.fn(async (token: string) =>
      token === "vyp_at_good"
        ? {
            appId: partnerApp.appId,
            connectionId: "c",
            propertyId: "22222222-2222-4222-8222-222222222222",
            scopes: ["promo_codes" as const],
          }
        : null,
    ),
    readHotel: vi.fn(async (propertyId: string) => ({
      hotelId: propertyId,
      name: "Hotel Alpina",
      currency: "EUR",
      bookingPageUrl: "https://alpina.booking.vayada.com",
      promoCodesEnabled: true,
      rooms: [],
    })),
    readApprovableProperties: vi.fn(async () => []),
    listConnections: vi.fn(async () => []),
    disconnect: vi.fn(async () => false),
    ...overrides,
  } satisfies PartnerConnectionsRepository;
}

async function partnerServer(repository: PartnerConnectionsRepository, now = () => 120_000) {
  const app = Fastify({ logger: false });
  await app.register(registerPartnerApiRoutes, {
    prefix: "/partner",
    repository,
    requestsPerMinute: 2,
    now,
  });
  return app;
}

const basic = (value: string) => `Basic ${Buffer.from(value).toString("base64")}`;
const form = (fields: string) => ({
  method: "POST" as const,
  url: "/partner/oauth/token",
  headers: {
    authorization: basic("partner_abc:s3cret"),
    "content-type": "application/x-www-form-urlencoded",
  },
  payload: fields,
});

describe("partner API (VAY-2436)", () => {
  it("answers 60-a-minute style limits per hotel with rate_limited and Retry-After", async () => {
    const app = await partnerServer(fakeRepository(), () => 150_000);
    const call = () =>
      app.inject({
        method: "GET",
        url: "/partner/v1/hotel",
        headers: { authorization: "Bearer vyp_at_good" },
      });
    expect((await call()).statusCode).toBe(200);
    expect((await call()).json()).toMatchObject({
      hotelId: "22222222-2222-4222-8222-222222222222",
    });
    const limited = await call();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("30");
    expect(limited.json()).toEqual({
      error: { code: "rate_limited", message: "Too many requests for this hotel. Try again soon." },
    });
  });

  it("answers /partner/v1 errors in the contract's shape", async () => {
    const app = await partnerServer(fakeRepository());
    const missing = await app.inject({ method: "GET", url: "/partner/v1/hotel" });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain("Bearer");
    expect(missing.json()).toEqual({
      error: { code: "unauthenticated", message: "A valid access token is required." },
    });
    const gone = await partnerServer(fakeRepository({ readHotel: async () => null }));
    const notFound = await gone.inject({
      method: "GET",
      url: "/partner/v1/hotel",
      headers: { authorization: "Bearer vyp_at_good" },
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json().error.code).toBe("not_found");
  });

  it("takes only form fields with HTTP Basic on the token call, and answers the OAuth way", async () => {
    const repository = fakeRepository();
    const app = await partnerServer(repository);
    const noClient = await app.inject({
      ...form("grant_type=refresh_token&refresh_token=x"),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(noClient.statusCode).toBe(401);
    expect(noClient.json()).toEqual({ error: "invalid_client" });
    expect(noClient.headers["cache-control"]).toBe("no-store");

    const repeated = await app.inject(
      form("grant_type=refresh_token&refresh_token=a&refresh_token=b"),
    );
    expect(repeated.statusCode).toBe(400);
    expect(repeated.json()).toEqual({ error: "invalid_request" });
    expect((await app.inject(form("refresh_token=a"))).json()).toEqual({
      error: "invalid_request",
    });
    expect((await app.inject(form("grant_type=password"))).json()).toEqual({
      error: "unsupported_grant_type",
    });
    expect((await app.inject(form("grant_type=authorization_code&code=x"))).json()).toEqual({
      error: "invalid_request",
    });
    expect(
      (await app.inject(form("grant_type=refresh_token&refresh_token=a&scope=everything"))).json(),
    ).toEqual({ error: "invalid_scope" });
    expect((await app.inject(form("grant_type=refresh_token&refresh_token=a"))).json()).toEqual({
      error: "invalid_grant",
    });
    expect(repository.refresh).toHaveBeenCalledWith({
      app: partnerApp,
      refreshToken: "a",
      scopes: null,
    });
    const text = await app.inject({
      ...form("x"),
      headers: { ...form("x").headers, "content-type": "application/xml" },
    });
    expect(text.statusCode).toBe(400);
    expect(text.json()).toEqual({ error: "invalid_request" });
  });

  it("returns the token response the contract describes", async () => {
    const app = await partnerServer(
      fakeRepository({
        exchangeCode: async () => ({
          accessToken: "vyp_at_x",
          refreshToken: "vyp_rt_x",
          expiresIn: 3600,
          scopes: ["promo_codes", "bookings"],
          hotel: { hotelId: "h", name: "Hotel Alpina" },
        }),
      }),
    );
    const response = await app.inject(
      form(
        "grant_type=authorization_code&code=c&redirect_uri=https%3A%2F%2Fpartner.example%2Fcallback&code_verifier=v",
      ),
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      access_token: "vyp_at_x",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "vyp_rt_x",
      scope: "promo_codes bookings",
      hotel: { hotelId: "h", name: "Hotel Alpina" },
    });
  });

  it("parses HTTP Basic and Bearer headers strictly", () => {
    expect(basicCredentials(basic("partner_abc:s3:cret"))).toEqual({
      clientId: "partner_abc",
      secret: "s3:cret",
    });
    expect(basicCredentials(basic(":secret"))).toBeNull();
    expect(basicCredentials(basic("id:"))).toBeNull();
    expect(basicCredentials("Bearer abc")).toBeNull();
    expect(basicCredentials(undefined)).toBeNull();
    expect(bearerToken("Bearer vyp_at_abc-_")).toBe("vyp_at_abc-_");
    expect(bearerToken("Bearer two words")).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
  });
});

describe("authorize requests (VAY-2436)", () => {
  const challenge = pkceChallenge("a".repeat(43));
  const valid = {
    response_type: "code",
    client_id: "partner_abc",
    redirect_uri: "https://partner.example/callback",
    scope: "promo_codes bookings",
    state: "s",
    code_challenge: challenge,
    code_challenge_method: "S256",
  };

  it("accepts a registered app's request with PKCE S256", () => {
    expect(checkAuthorizationRequest(partnerApp, valid)).toEqual({
      ok: true,
      request: {
        app: partnerApp,
        redirectUri: valid.redirect_uri,
        scopes: ["promo_codes", "bookings"],
        codeChallenge: challenge,
        state: "s",
      },
    });
    // No scope means what the app was registered for.
    const withoutScope: Record<string, string> = { ...valid };
    delete withoutScope["scope"];
    expect(checkAuthorizationRequest(partnerApp, withoutScope)).toMatchObject({
      ok: true,
      request: { scopes: ["promo_codes", "bookings"] },
    });
  });

  it("never redirects to an unregistered address, and redirects other errors with state", () => {
    expect(checkAuthorizationRequest(null, valid)).toEqual({
      ok: false,
      redirectable: false,
      error: "invalid_client",
    });
    expect(
      checkAuthorizationRequest(partnerApp, {
        ...valid,
        redirect_uri: "https://partner.example/callback/",
      }),
    ).toMatchObject({ redirectable: false, error: "invalid_redirect_uri" });
    expect(
      checkAuthorizationRequest(partnerApp, {
        ...valid,
        redirect_uri: ["https://partner.example/callback"],
      }),
    ).toMatchObject({ redirectable: false, error: "invalid_redirect_uri" });
    const narrow = { ...partnerApp, allowedScopes: ["promo_codes" as const] };
    const scope = checkAuthorizationRequest(narrow, valid);
    expect(scope).toMatchObject({ ok: false, redirectable: true, error: "invalid_scope" });
    if (!scope.ok && scope.redirectable)
      expect(scope.redirectTo).toBe("https://partner.example/callback?error=invalid_scope&state=s");
    expect(
      checkAuthorizationRequest(partnerApp, { ...valid, code_challenge: "short" }),
    ).toMatchObject({ error: "invalid_request" });
  });

  it("checks scopes and PKCE verifiers exactly", () => {
    expect(parseScopes("bookings promo_codes")).toEqual(["promo_codes", "bookings"]);
    expect(parseScopes("bookings bookings")).toBeNull();
    expect(parseScopes("bookings  promo_codes")).toBeNull();
    expect(parseScopes("guests")).toBeNull();
    // RFC 7636 appendix B.
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    expect(
      pkceMatches(
        "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      ),
    ).toBe(true);
    expect(pkceMatches("short", pkceChallenge("short"))).toBe(false);
  });
});

describe("partner app registration (VAY-2436)", () => {
  it("takes exact https return addresses and known scopes only", () => {
    expect(
      parsePartnerAppRegistrationArgs([
        "--name",
        "Creator Links",
        "--redirect-uri",
        "https://partner.example/callback",
        "--webhook-url",
        "https://partner.example/hooks",
        "--apply",
      ]),
    ).toEqual({
      name: "Creator Links",
      redirectUris: ["https://partner.example/callback"],
      scopes: ["promo_codes", "bookings"],
      webhookUrl: "https://partner.example/hooks",
      contactEmail: null,
      termsVersion: "partner-contract-2026-10-31",
      apply: true,
    });
    expect(checkRedirectUri("http://localhost:3000/callback")).toBe(true);
    expect(checkRedirectUri("http://partner.example/callback")).toBe(false);
    expect(checkRedirectUri("https://partner.example/callback#x")).toBe(false);
    expect(checkRedirectUri("https://partner.example")).toBe(false);
    expect(() =>
      parsePartnerAppRegistrationArgs([
        "--name",
        "X",
        "--redirect-uri",
        "https://a.example/cb",
        "--scope",
        "guests",
      ]),
    ).toThrow(/--scope/);
    expect(() =>
      parsePartnerAppRegistrationArgs(["--redirect-uri", "https://a.example/cb"]),
    ).toThrow(/--name/);
  });
});

describe("the WorkOS check and partner tokens (VAY-2436)", () => {
  it("refuses a partner token as a WorkOS token before fetching any keys", async () => {
    const verify = createWorkOSVerifier({
      jwksUrl: "https://127.0.0.1:9/never-fetched",
      issuer: "https://api.workos.com/user_management/client_test",
      audience: "client_test",
    });
    await expect(
      verify("vyp_at_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("does not run the WorkOS check on /partner paths", async () => {
    const verifier = vi.fn(async () => {
      throw new AuthError("TOKEN_INVALID", "never valid");
    });
    const app = Fastify({ logger: false });
    await app.register(backendAuthPlugin, {
      verifier,
      repository: {} as never,
      skipPathPrefixes: ["/partner/"],
    });
    app.get("/partner/v1/hotel", async () => ({ ok: true }));
    app.get("/api/x", async () => ({ ok: true }));
    await app.inject({
      method: "GET",
      url: "/partner/v1/hotel",
      headers: { authorization: "Bearer t" },
    });
    expect(verifier).not.toHaveBeenCalled();
    await app.inject({ method: "GET", url: "/api/x", headers: { authorization: "Bearer t" } });
    expect(verifier).toHaveBeenCalledTimes(1);
  });
});
