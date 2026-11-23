import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BookingCustomDomainVerifier } from "./bookingCustomDomainVerification.js";
import {
  GoogleMapsKeyError,
  addVerifiedDomainsToMapsKey,
  createGoogleMapsKeyWebsites,
  startMapsKeyWebsitesSync,
  type MapsKeyWebsites,
} from "./googleMapsKeyWebsites.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const credentialsJson = JSON.stringify({
  type: "service_account",
  project_id: "vayada-maps",
  private_key_id: "kid-1",
  private_key: privateKey,
  client_email: "maps-key-editor@vayada-maps.iam.gserviceaccount.com",
});
const keyName = "projects/vayada-maps/locations/global/keys/key-1";
const storedName = "projects/123456/locations/global/keys/key-1";
const keyUrl = `https://apikeys.googleapis.com/v2/${keyName}`;
const patchUrl = `https://apikeys.googleapis.com/v2/${storedName}?updateMask=restrictions`;
const apiTargets = [{ service: "maps-backend.googleapis.com" }];
const listed = ["https://*.next-booking.vayada.com/*", "http://localhost:3002/*"];
const NOW = Date.UTC(2026, 10, 23, 12);

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function key(referrers: string[] | undefined, etag = "etag-1") {
  return {
    name: storedName,
    displayName: "Maps browser key",
    etag,
    restrictions: {
      ...(referrers ? { browserKeyRestrictions: { allowedReferrers: referrers } } : {}),
      apiTargets,
    },
  };
}

/** Google's token endpoint and API Keys API; `keys` answers each read in turn, `patches` each update. */
function google(keys: unknown[], patches: Array<[number, unknown]> = [[200, { name: "op-1" }]]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = {
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? init.body : "",
    };
    calls.push(call);
    if (call.url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "access-1", expires_in: 3599, token_type: "Bearer" });
    }
    if (call.method === "GET") return Response.json(keys.shift());
    const [status, body] = patches.shift() ?? [500, {}];
    return Response.json(body, { status });
  });
  return { calls, fetch };
}

function websites(
  fetch: typeof globalThis.fetch,
  overrides: { keyName?: string; json?: string } = {},
) {
  return createGoogleMapsKeyWebsites({
    keyName: overrides.keyName ?? keyName,
    credentialsJson: overrides.json ?? credentialsJson,
    fetch,
    now: () => NOW,
  });
}

describe("Google Maps key websites (VAY-2589)", () => {
  it("adds a missing hotel domain and keeps every entry and the key's other settings", async () => {
    const { calls, fetch } = google([key(listed)]);

    await expect(websites(fetch).allow(["booking.hotel.example"])).resolves.toEqual([
      "booking.hotel.example",
    ]);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://oauth2.googleapis.com/token",
      `GET ${keyUrl}`,
      `PATCH ${patchUrl}`,
    ]);
    // The service account signs its own token request.
    const form = new URLSearchParams(calls[0].body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = form.get("assertion")!.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: "maps-key-editor@vayada-maps.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    });
    expect(
      createVerify("RSA-SHA256")
        .update(`${header}.${claims}`)
        .verify(publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
    expect(calls[1].headers.Authorization).toBe("Bearer access-1");
    expect(calls[2].headers.Authorization).toBe("Bearer access-1");
    expect(JSON.parse(calls[2].body)).toEqual({
      restrictions: {
        browserKeyRestrictions: {
          allowedReferrers: [...listed, "https://booking.hotel.example/*"],
        },
        apiTargets,
      },
      etag: "etag-1",
    });
  });

  it("changes nothing for a domain already on the list, and asks for one token per hour", async () => {
    const { calls, fetch } = google([
      key([...listed, "https://booking.hotel.example/*"]),
      key([...listed, "booking.hotel.example/*"]),
    ]);
    const maps = websites(fetch);

    await expect(maps.allow(["Booking.Hotel.Example.", "booking.hotel.example"])).resolves.toEqual(
      [],
    );
    await expect(maps.allow(["booking.hotel.example"])).resolves.toEqual([]);

    expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "GET"]);
  });

  it("calls nothing without a valid hostname", async () => {
    const { fetch } = google([]);

    await expect(
      websites(fetch).allow(["", "*.example.com", "a b.example", "localhost"]),
    ).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves a key without a website list as it is", async () => {
    const { calls, fetch } = google([key(undefined), key([])]);
    const maps = websites(fetch);

    await expect(maps.allow(["booking.hotel.example"])).rejects.toThrow(
      "The Maps key has no website list; it was left as it is.",
    );
    await expect(maps.allow(["booking.hotel.example"])).rejects.toThrow("no website list");
    expect(calls.filter((call) => call.method === "PATCH")).toEqual([]);
  });

  it("reads the key again once when it changed since it was read", async () => {
    const changed = [...listed, "https://booking.other.example/*"];
    const { calls, fetch } = google(
      [key(listed), key(changed, "etag-2")],
      [
        [409, { error: { code: 409, status: "ABORTED", message: "etag mismatch" } }],
        [200, { name: "op-2", done: true }],
      ],
    );

    await expect(websites(fetch).allow(["booking.hotel.example"])).resolves.toEqual([
      "booking.hotel.example",
    ]);

    const patches = calls
      .filter((call) => call.method === "PATCH")
      .map((call) => JSON.parse(call.body));
    expect(patches).toHaveLength(2);
    expect(patches[1]).toEqual({
      restrictions: {
        browserKeyRestrictions: {
          allowedReferrers: [...changed, "https://booking.hotel.example/*"],
        },
        apiTargets,
      },
      etag: "etag-2",
    });
  });

  it("gives up after the second refused update, and reports a failed change", async () => {
    const refused: [number, unknown] = [409, { error: { status: "ABORTED" } }];
    const first = google([key(listed), key(listed)], [refused, refused]);
    await expect(websites(first.fetch).allow(["booking.hotel.example"])).rejects.toEqual(
      new GoogleMapsKeyError("update", 409, "ABORTED"),
    );

    const failed: [number, unknown] = [
      200,
      { name: "op-1", done: true, error: { code: 3, status: "INVALID_ARGUMENT" } },
    ];
    const second = google([key(listed), key(listed)], [failed, failed]);
    await expect(websites(second.fetch).allow(["booking.hotel.example"])).rejects.toThrow(
      "Google Maps key update failed (HTTP 200; INVALID_ARGUMENT).",
    );
  });

  it("reports a refused token or read without the key or the token", async () => {
    const tokenRefused = vi.fn(async () =>
      Response.json({ error: "invalid_grant", error_description: "Invalid JWT" }, { status: 400 }),
    );
    const error = await websites(tokenRefused)
      .allow(["booking.hotel.example"])
      .catch((caught: unknown) => caught);
    expect(error).toEqual(new GoogleMapsKeyError("token", 400, "invalid_grant"));

    const readRefused = google([]);
    readRefused.fetch.mockImplementation(async (url: string | URL | Request) =>
      String(url).includes("oauth2")
        ? Response.json({ access_token: "access-1", expires_in: 3599 })
        : Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: 403 }),
    );
    const readError = await websites(readRefused.fetch)
      .allow(["booking.hotel.example"])
      .catch((caught: unknown) => caught);
    expect(readError).toEqual(new GoogleMapsKeyError("read", 403, "PERMISSION_DENIED"));
    expect(String((readError as Error).message)).not.toContain("access-1");
  });

  it("refuses broken settings without quoting them", async () => {
    const { fetch } = google([]);
    const broken = `{"type":"service_account","private_key":"${privateKey.slice(30, 60)}`;

    const parseError = await websites(fetch, { json: broken })
      .allow(["booking.hotel.example"])
      .catch((caught: unknown) => caught as Error);
    expect(parseError.message).toBe("The Maps key editor credentials are not valid JSON.");
    await expect(
      websites(fetch, { json: '{"type":"authorized_user"}' }).allow(["booking.hotel.example"]),
    ).rejects.toThrow("not a service account key");
    await expect(
      websites(fetch, { keyName: "key-1" }).allow(["booking.hotel.example"]),
    ).rejects.toThrow("projects/<project>/locations/global/keys/<key id>");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("verified domains onto the Maps key (VAY-2589)", () => {
  const verified = { status: "verified", issue: null, recordHost: null, errors: [] } as const;
  const pending = {
    status: "pending",
    issue: { code: "certificate_pending", foundTarget: null },
    recordHost: null,
    errors: [],
  } as const;

  function setUp(allow: MapsKeyWebsites["allow"]) {
    const check = vi.fn<BookingCustomDomainVerifier["check"]>();
    const release = vi.fn<BookingCustomDomainVerifier["release"]>(async () => "deleted");
    const reports: unknown[] = [];
    const verifier = addVerifiedDomainsToMapsKey(
      { check, release },
      { allow: vi.fn(allow) },
      (outcome) => reports.push(outcome),
    );
    return { check, release, reports, verifier };
  }

  it("adds a domain once it verifies, and only then", async () => {
    const allow = vi.fn(async (hosts: readonly string[]) => [...hosts]);
    const { check, reports, verifier } = setUp(allow);
    check.mockResolvedValueOnce(pending).mockResolvedValueOnce(verified);

    await expect(verifier.check("booking.hotel.example", "p-1")).resolves.toBe(pending);
    await expect(verifier.check("booking.hotel.example", "p-1")).resolves.toBe(verified);

    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(allow).toHaveBeenCalledOnce();
    expect(allow).toHaveBeenCalledWith(["booking.hotel.example"]);
    expect(reports).toEqual([{ host: "booking.hotel.example", added: true }]);
  });

  it("answers verified even when Google fails, and reports the failure", async () => {
    const failure = new GoogleMapsKeyError("update", 503, "UNAVAILABLE");
    const { check, release, reports, verifier } = setUp(async () => {
      throw failure;
    });
    check.mockResolvedValue(verified);

    await expect(verifier.check("booking.hotel.example", "p-1")).resolves.toBe(verified);
    await vi.waitFor(() =>
      expect(reports).toEqual([{ host: "booking.hotel.example", error: failure }]),
    );
    await expect(verifier.release("ch-1")).resolves.toBe("deleted");
    expect(release).toHaveBeenCalledWith("ch-1");
  });
});

describe("Maps key website pass (VAY-2589)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a minute after start and then hourly, one pass at a time, until stopped", async () => {
    vi.useFakeTimers();
    let finish: (added: string[]) => void = () => {};
    const allow = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          finish = resolve;
        }),
    );
    const reports: unknown[] = [];
    const stop = startMapsKeyWebsitesSync({
      websites: { allow },
      hosts: () => ["booking.hotel.example", "booking.other.example"],
      report: (outcome) => reports.push(outcome),
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(allow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(allow).toHaveBeenCalledWith(["booking.hotel.example", "booking.other.example"]);

    // Still running an hour later: no second pass on top.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(allow).toHaveBeenCalledOnce();
    finish(["booking.other.example"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(reports).toEqual([{ added: ["booking.other.example"] }]);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(allow).toHaveBeenCalledTimes(2);
    finish([]);
    await stop();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(allow).toHaveBeenCalledTimes(2);
    expect(reports).toEqual([{ added: ["booking.other.example"] }, { added: [] }]);
  });

  it("reports a failed pass", async () => {
    vi.useFakeTimers();
    const error = new Error("offline");
    const reports: unknown[] = [];
    const stop = startMapsKeyWebsitesSync({
      websites: { allow: vi.fn(async () => Promise.reject(error)) },
      hosts: () => ["booking.hotel.example"],
      report: (outcome) => reports.push(outcome),
      firstRunMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(reports).toEqual([{ error }]);
    await stop();
  });
});
