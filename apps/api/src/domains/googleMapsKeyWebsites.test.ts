import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GoogleMapsKeyError,
  createGoogleMapsKeyWebsites,
  startMapsKeyWebsitesSync,
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
  overrides: { keyName?: string; json?: string; now?: () => number } = {},
) {
  return createGoogleMapsKeyWebsites({
    keyName: overrides.keyName ?? keyName,
    credentialsJson: overrides.json ?? credentialsJson,
    fetch,
    now: overrides.now ?? (() => NOW),
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

  it("keeps settings it doesn't know about", async () => {
    const future = {
      name: storedName,
      etag: "etag-1",
      restrictions: {
        browserKeyRestrictions: { allowedReferrers: listed, futureSetting: { on: true } },
        apiTargets,
        futureRestriction: "kept",
      },
    };
    const { calls, fetch } = google([future]);

    await websites(fetch).allow(["booking.hotel.example"]);

    expect(JSON.parse(calls[2].body).restrictions).toEqual({
      browserKeyRestrictions: {
        allowedReferrers: [...listed, "https://booking.hotel.example/*"],
        futureSetting: { on: true },
      },
      apiTargets,
      futureRestriction: "kept",
    });
  });

  it("changes nothing for a domain already on the list, with one token for both reads", async () => {
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

  it("asks for a new token when the old one runs out, or once Google refuses it", async () => {
    let now = NOW;
    const listedAlready = () => key([...listed, "https://booking.hotel.example/*"]);
    const { calls, fetch } = google([listedAlready(), listedAlready(), listedAlready()]);
    const maps = websites(fetch, { now: () => now });

    await maps.allow(["booking.hotel.example"]);
    now += 59 * 60_000;
    await maps.allow(["booking.hotel.example"]);
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "POST", "GET"]);

    // A revoked service account key: the cached token stops working before it runs out.
    fetch.mockImplementationOnce(async () =>
      Response.json({ error: { status: "UNAUTHENTICATED" } }, { status: 401 }),
    );
    await expect(maps.allow(["booking.hotel.example"])).rejects.toEqual(
      new GoogleMapsKeyError("read", 401, "UNAUTHENTICATED"),
    );
    await maps.allow(["booking.hotel.example"]);
    // The refused read isn't in `calls` (it was answered by the one-off reply above).
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "POST", "GET", "POST", "GET"]);
  });

  it("calls nothing without a valid hostname", async () => {
    const { fetch } = google([]);

    await expect(
      websites(fetch).allow(["", "*.example.com", "a b.example", "localhost"]),
    ).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves a key without a website list as it is", async () => {
    const serverKey = {
      name: storedName,
      etag: "etag-1",
      restrictions: { serverKeyRestrictions: { allowedIps: ["203.0.113.7"] }, apiTargets },
    };
    const { calls, fetch } = google([key(undefined), key([]), serverKey]);
    const maps = websites(fetch);

    await expect(maps.allow(["booking.hotel.example"])).rejects.toThrow(
      "The Maps key has no website list; it was left as it is.",
    );
    await expect(maps.allow(["booking.hotel.example"])).rejects.toThrow("no website list");
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

  it("stops when the second read already has the domain", async () => {
    const { calls, fetch } = google(
      [key(listed), key([...listed, "https://booking.hotel.example/*"], "etag-2")],
      [[400, { error: { status: "FAILED_PRECONDITION" } }]],
    );

    await expect(websites(fetch).allow(["booking.hotel.example"])).resolves.toEqual([]);
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  it("gives up after the second stale update, and retries no other refusal", async () => {
    const stale: [number, unknown] = [409, { error: { status: "ABORTED" } }];
    const first = google([key(listed), key(listed)], [stale, stale]);
    await expect(websites(first.fetch).allow(["booking.hotel.example"])).rejects.toEqual(
      new GoogleMapsKeyError("update", 409, "ABORTED"),
    );

    const denied = google([key(listed)], [[403, { error: { status: "PERMISSION_DENIED" } }]]);
    await expect(websites(denied.fetch).allow(["booking.hotel.example"])).rejects.toEqual(
      new GoogleMapsKeyError("update", 403, "PERMISSION_DENIED"),
    );
    expect(denied.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);

    const failed = google(
      [key(listed)],
      [[200, { name: "op-1", done: true, error: { code: 3, status: "INVALID_ARGUMENT" } }]],
    );
    await expect(websites(failed.fetch).allow(["booking.hotel.example"])).rejects.toThrow(
      "Google Maps key update failed (HTTP 200; INVALID_ARGUMENT).",
    );
    expect(failed.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
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
      .then(
        () => null,
        (caught: unknown) => caught as Error,
      );
    expect(parseError?.message).toBe("The Maps key editor credentials are not valid JSON.");
    await expect(
      websites(fetch, { json: '{"type":"authorized_user"}' }).allow(["booking.hotel.example"]),
    ).rejects.toThrow("not a service account key");
    for (const badName of ["key-1", `${keyName}?updateMask=displayName`]) {
      await expect(
        websites(fetch, { keyName: badName }).allow(["booking.hotel.example"]),
      ).rejects.toThrow("projects/<project>/locations/global/keys/<key id>");
    }
    expect(fetch).not.toHaveBeenCalled();
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
    const hosts = vi.fn(async () => ["booking.hotel.example", "booking.other.example"]);
    const { stop } = startMapsKeyWebsitesSync({
      websites: { allow },
      hosts,
      report: (outcome) => reports.push(outcome),
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(allow).not.toHaveBeenCalled();
    expect(hosts).not.toHaveBeenCalled();
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
    // Stopping doesn't wait for the pass in flight, which still finishes and reports.
    stop();
    finish([]);
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(allow).toHaveBeenCalledTimes(2);
    expect(reports).toEqual([{ added: ["booking.other.example"] }, { added: [] }]);
  });

  it("reports a failed pass, and keeps going when reporting fails", async () => {
    vi.useFakeTimers();
    const error = new Error("offline");
    const reports: unknown[] = [];
    const allow = vi.fn(async () => Promise.reject(error));
    const { stop } = startMapsKeyWebsitesSync({
      websites: { allow },
      hosts: async () => ["booking.hotel.example"],
      report: (outcome) => {
        reports.push(outcome);
        throw new Error("the logger failed");
      },
      firstRunMs: 10,
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(reports).toEqual([{ error }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(allow).toHaveBeenCalledTimes(2);
    stop();
  });

  it("reads the verified domains on each pass, and runs soon after a verification (VAY-2579)", async () => {
    vi.useFakeTimers();
    let verified = ["booking.hotel.example"];
    let finish: (added: string[]) => void = () => {};
    const allow = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          finish = resolve;
        }),
    );
    const { stop, runSoon } = startMapsKeyWebsitesSync({
      websites: { allow },
      hosts: async () => verified,
      report: () => {},
      firstRunMs: 60_000,
      soonMs: 5_000,
    });

    // A domain verified before the first pass: it runs 5 s later, once even if asked twice.
    runSoon();
    runSoon();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(allow).toHaveBeenCalledTimes(1);
    expect(allow).toHaveBeenLastCalledWith(["booking.hotel.example"]);

    // Another one verified during that pass: it runs as soon as the pass ends, with the new list.
    verified = ["booking.hotel.example", "booking.other.example"];
    runSoon();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(allow).toHaveBeenCalledTimes(1);
    finish([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(allow).toHaveBeenCalledTimes(2);
    expect(allow).toHaveBeenLastCalledWith(["booking.hotel.example", "booking.other.example"]);
    finish(["booking.other.example"]);

    // Once stopped (the server closing), nothing more runs.
    stop();
    runSoon();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(allow).toHaveBeenCalledTimes(2);
  });

  it("reports a failed read of the verified domains", async () => {
    vi.useFakeTimers();
    const error = new Error("database unavailable");
    const reports: unknown[] = [];
    const allow = vi.fn(async () => []);
    const { stop } = startMapsKeyWebsitesSync({
      websites: { allow },
      hosts: async () => Promise.reject(error),
      report: (outcome) => reports.push(outcome),
      firstRunMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(reports).toEqual([{ error }]);
    expect(allow).not.toHaveBeenCalled();
    stop();
  });
});
