import { createSign } from "node:crypto";
import type { BookingCustomDomainVerifier } from "./bookingCustomDomainVerification.js";

/**
 * The browser Maps key's website list (VAY-2589). Google refuses the key on any website missing from
 * it ("The map couldn't load right now"), so each hotel's own booking domain needs an entry. next-api
 * adds them through Google's API Keys API with a service account that may only read and update API
 * keys. It only ever adds: every entry already on the list stays, and so do the key's other settings.
 */
export type MapsKeyWebsites = {
  /** Adds "https://<host>/*" for each host the list lacks; returns the hosts it added. */
  allow(hosts: readonly string[]): Promise<string[]>;
};

/** A Google call that failed; carries only the step, HTTP status and Google's status, never a secret. */
export class GoogleMapsKeyError extends Error {
  constructor(
    readonly step: "token" | "read" | "update",
    readonly httpStatus: number,
    readonly googleStatus: string | null,
  ) {
    super(
      `Google Maps key ${step} failed (HTTP ${httpStatus}${googleStatus ? `; ${googleStatus}` : ""}).`,
    );
    this.name = "GoogleMapsKeyError";
  }
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_KEYS_URL = "https://apikeys.googleapis.com/v2/";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const KEY_NAME = /^projects\/[^/]+\/locations\/global\/keys\/[^/]+$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

type Key = {
  name?: unknown;
  etag?: unknown;
  restrictions?: Record<string, unknown> & {
    browserKeyRestrictions?: Record<string, unknown> & { allowedReferrers?: unknown };
  };
};

export function createGoogleMapsKeyWebsites(config: {
  /** projects/<project>/locations/global/keys/<key id> */
  keyName: string;
  /** The service account's JSON key, as Google downloads it. */
  credentialsJson: string;
  fetch?: typeof fetch;
  now?: () => number;
}): MapsKeyWebsites {
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  let token: { value: string; expiresAt: number } | undefined;

  const accessToken = async () => {
    if (token && token.expiresAt - 60_000 > now()) return token.value;
    const account = readServiceAccount(config.credentialsJson);
    const issuedAt = Math.floor(now() / 1000);
    const unsigned = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({
      iss: account.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    })}`;
    const signature = createSign("RSA-SHA256")
      .update(unsigned)
      .sign(account.privateKey)
      .toString("base64url");
    const response = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }).toString(),
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
      error?: unknown;
    };
    if (!response.ok || typeof body.access_token !== "string") {
      throw new GoogleMapsKeyError(
        "token",
        response.status,
        typeof body.error === "string" ? body.error : null,
      );
    }
    token = {
      value: body.access_token,
      expiresAt: now() + (Number(body.expires_in) || 3600) * 1000,
    };
    return token.value;
  };

  const call = async (step: "read" | "update", path: string, init: RequestInit = {}) => {
    const response = await doFetch(`${API_KEYS_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
      error?: { status?: unknown };
    };
    if (!response.ok) {
      throw new GoogleMapsKeyError(
        step,
        response.status,
        typeof body.error?.status === "string" ? body.error.status : null,
      );
    }
    return body;
  };

  return {
    async allow(hosts) {
      const wanted = [
        ...new Set(hosts.map((host) => host.trim().toLowerCase().replace(/\.$/, ""))),
      ];
      const valid = wanted.filter((host) => HOSTNAME.test(host));
      if (valid.length === 0) return [];
      if (!KEY_NAME.test(config.keyName)) {
        throw new Error(
          "The Maps key name must look like projects/<project>/locations/global/keys/<key id>.",
        );
      }

      // A change made since the read (the etag no longer matches) fails the update: read it again once.
      for (let attempt = 1; ; attempt += 1) {
        const key = (await call("read", config.keyName)) as Key;
        const browser = key.restrictions?.browserKeyRestrictions;
        const referrers = browser?.allowedReferrers;
        // A key without a website list allows every website, or is not a browser key: leave it.
        if (
          !Array.isArray(referrers) ||
          referrers.length === 0 ||
          typeof key.name !== "string" ||
          typeof key.etag !== "string"
        ) {
          throw new Error("The Maps key has no website list; it was left as it is.");
        }
        const listed = new Set(referrers);
        const missing = valid.filter(
          (host) => !listed.has(`https://${host}/*`) && !listed.has(`${host}/*`),
        );
        if (missing.length === 0) return [];

        try {
          const operation = await call("update", `${key.name}?updateMask=restrictions`, {
            method: "PATCH",
            body: JSON.stringify({
              restrictions: {
                ...key.restrictions,
                browserKeyRestrictions: {
                  ...browser,
                  allowedReferrers: [...referrers, ...missing.map((host) => `https://${host}/*`)],
                },
              },
              etag: key.etag,
            }),
          });
          const failure = operation.error;
          if (failure) {
            throw new GoogleMapsKeyError(
              "update",
              200,
              typeof failure.status === "string" ? failure.status : null,
            );
          }
          return missing;
        } catch (error) {
          if (attempt >= 2) throw error;
        }
      }
    },
  };
}

/**
 * A domain that verifies goes onto the Maps key's website list at once, after the check answers; a
 * failure is reported, and the hourly pass (`startMapsKeyWebsitesSync`) tries again.
 */
export function addVerifiedDomainsToMapsKey(
  verifier: BookingCustomDomainVerifier,
  websites: MapsKeyWebsites,
  report: (outcome: { host: string; added: boolean } | { host: string; error: unknown }) => void,
): BookingCustomDomainVerifier {
  return {
    async check(hostname, propertyId) {
      const result = await verifier.check(hostname, propertyId);
      if (result.status === "verified") {
        websites.allow([hostname]).then(
          (added) => report({ host: hostname, added: added.length > 0 }),
          (error: unknown) => report({ host: hostname, error }),
        );
      }
      return result;
    },
    release: (hostnameId) => verifier.release(hostnameId),
  };
}

/**
 * Puts every hotel domain the booking page is served on (platform's next_booking_custom_domains) onto
 * the Maps key's website list a minute after start and then hourly. It covers the hotels connected
 * before VAY-2589 and any domain whose addition failed. Returns the stop function.
 */
export function startMapsKeyWebsitesSync(options: {
  websites: MapsKeyWebsites;
  hosts: () => readonly string[];
  report: (outcome: { added: string[] } | { error: unknown }) => void;
  firstRunMs?: number;
  intervalMs?: number;
}): () => Promise<void> {
  let running: Promise<void> | undefined;
  const run = () => {
    if (running) return;
    running = options.websites
      .allow(options.hosts())
      .then(
        (added) => options.report({ added }),
        (error: unknown) => options.report({ error }),
      )
      .finally(() => {
        running = undefined;
      });
  };
  const first = setTimeout(run, options.firstRunMs ?? 60_000);
  const timer = setInterval(run, options.intervalMs ?? 60 * 60_000);
  first.unref();
  timer.unref();
  return async () => {
    clearTimeout(first);
    clearInterval(timer);
    await running;
  };
}

function readServiceAccount(json: string): { clientEmail: string; privateKey: string } {
  let value: { type?: unknown; client_email?: unknown; private_key?: unknown };
  try {
    value = JSON.parse(json) as typeof value;
  } catch {
    // JSON.parse quotes the text it choked on, which would put part of the key in the logs.
    throw new Error("The Maps key editor credentials are not valid JSON.");
  }
  if (
    value?.type !== "service_account" ||
    typeof value.client_email !== "string" ||
    typeof value.private_key !== "string"
  ) {
    throw new Error("The Maps key editor credentials are not a service account key.");
  }
  return { clientEmail: value.client_email, privateKey: value.private_key };
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
