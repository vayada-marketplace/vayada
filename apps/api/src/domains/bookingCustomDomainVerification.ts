import { Resolver } from "node:dns/promises";

/** Every hotel domain points here; Cloudflare for SaaS serves it (fallback origin → the ALB). */
export const BOOKING_CUSTOM_DOMAIN_CNAME_TARGET = "custom.booking.vayada.com";

export type BookingCustomDomainIssueCode =
  | "dns_record_missing"
  | "dns_record_wrong_target"
  | "certificate_pending"
  | "routing_pending"
  | "hostname_rejected"
  | "check_unavailable";

export type BookingCustomDomainCheckResult = {
  status: "verified" | "pending" | "failed";
  issue: { code: BookingCustomDomainIssueCode; foundTarget: string | null } | null;
  /** The record's name as typed in the hotel's DNS panel ("booking" for booking.example.com);
   * null when unknown, and the page then shows the whole hostname. */
  recordHost: string | null;
  errors: string[];
};

export type BookingCustomDomainVerifier = {
  check(hostname: string, propertyId: string): Promise<BookingCustomDomainCheckResult>;
};

export type CloudflareCustomHostname = {
  id: string;
  status: string;
  sslStatus: string;
  errors: string[];
};

export type CloudflareCustomHostnames = {
  find(hostname: string): Promise<CloudflareCustomHostname | null>;
  /** Registers the hostname; adopts it when a concurrent check registered it a moment ago. */
  create(hostname: string): Promise<CloudflareCustomHostname>;
  /** Asks Cloudflare to validate again after its validation window ran out. */
  restartValidation(id: string): Promise<CloudflareCustomHostname>;
};

export type CustomDomainDns = {
  /** The hostname's CNAME target, or null when it has none (no record, or no such name). */
  cnameTarget(hostname: string): Promise<string | null>;
  recordHost(hostname: string): Promise<string | null>;
};

/** A Cloudflare API call that failed; carries only status and error codes, never the token. */
export class CloudflareCustomHostnameError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly codes: readonly number[],
  ) {
    super(
      `Cloudflare custom hostname request failed (HTTP ${httpStatus}; codes ${codes.join(",") || "none"}).`,
    );
    this.name = "CloudflareCustomHostnameError";
  }
}

// The same SSL settings the old booking-api used: HTTP validation through the hotel's CNAME.
const SSL_SETTINGS = { method: "http", type: "dv", settings: { min_tls_version: "1.2" } };
const HOSTNAME_ALREADY_EXISTS = 1406;
// Cloudflare is removing or refusing the hostname: Vayada has to look at it.
const REJECTED_STATUSES = new Set(["blocked", "deleted", "pending_deletion"]);

export function createCloudflareCustomHostnames(config: {
  apiToken: string;
  zoneId: string;
  fetch?: typeof fetch;
}): CloudflareCustomHostnames {
  const doFetch = config.fetch ?? fetch;
  const base = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(config.zoneId)}/custom_hostnames`;
  const call = async (url: string, init: RequestInit = {}) => {
    const response = await doFetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
      // At most three calls per check, so a check stays well under the ALB's 60 s idle timeout.
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      result?: unknown;
      errors?: Array<{ code?: unknown }>;
    };
    if (response.ok && body.success) return body.result;
    throw new CloudflareCustomHostnameError(
      response.status,
      (body.errors ?? []).map((error) => Number(error.code)).filter(Number.isFinite),
    );
  };
  const find = async (hostname: string) => {
    const rows = (await call(`${base}?hostname=${encodeURIComponent(hostname)}`)) as unknown[];
    const row = (Array.isArray(rows) ? rows : []).find(
      (candidate) => (candidate as { hostname?: unknown }).hostname === hostname,
    );
    return row ? toCustomHostname(row) : null;
  };

  return {
    find,
    async create(hostname) {
      try {
        return toCustomHostname(
          await call(base, {
            method: "POST",
            body: JSON.stringify({ hostname, ssl: SSL_SETTINGS }),
          }),
        );
      } catch (error) {
        // Created by a concurrent check a moment ago.
        if (
          error instanceof CloudflareCustomHostnameError &&
          error.codes.includes(HOSTNAME_ALREADY_EXISTS)
        ) {
          const created = await find(hostname);
          if (created) return created;
        }
        throw error;
      }
    },
    async restartValidation(id) {
      return toCustomHostname(
        await call(`${base}/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ ssl: SSL_SETTINGS }),
        }),
      );
    },
  };
}

export function createCustomDomainDns(
  resolver: Pick<Resolver, "resolveCname" | "resolveSoa"> = new Resolver({
    timeout: 2_000,
    tries: 2,
  }),
): CustomDomainDns {
  return {
    async cnameTarget(hostname) {
      try {
        const [target] = await resolver.resolveCname(hostname);
        return target ? normalizeHostname(target) : null;
      } catch (error) {
        if (isMissingName(error)) return null;
        throw error;
      }
    },
    async recordHost(hostname) {
      // The closest parent with its own SOA is the zone the hotel edits ("example.co.id" too).
      // The hostname itself is skipped: an SOA query follows its CNAME, and a CNAME can't sit
      // at a zone's apex anyway.
      const labels = hostname.split(".");
      for (let index = 1; index < labels.length - 1; index += 1) {
        try {
          await resolver.resolveSoa(labels.slice(index).join("."));
          return labels.slice(0, index).join(".");
        } catch (error) {
          if (!isMissingName(error)) return null;
        }
      }
      return null;
    },
  };
}

/**
 * Cloudflare decides: a hostname with an active certificate is verified, but only for the
 * property the load balancer routes it for (`routes`, from platform's next_booking_custom_domains).
 * A verified domain becomes the page's address and booking-web redirects guests to it, so it must
 * reach the new booking frontend; and Vayada naming the property proves whose domain it is (an
 * old-system hotel's hostname is already active in Cloudflare). Otherwise the hotel's DNS explains
 * why. The hostname is only registered with Cloudflare once its CNAME is right, so typos and
 * abandoned domains leave nothing behind.
 */
export function createBookingCustomDomainVerifier(dependencies: {
  cloudflare: CloudflareCustomHostnames;
  dns: CustomDomainDns;
  /** hostname → the property id it is routed for. */
  routes: ReadonlyMap<string, string>;
}): BookingCustomDomainVerifier {
  const active = (custom: CloudflareCustomHostname) =>
    custom.status === "active" && custom.sslStatus === "active";
  const ready = (
    hostname: string,
    propertyId: string,
    recordHost: string | null,
  ): BookingCustomDomainCheckResult =>
    dependencies.routes.get(hostname) === propertyId.toLowerCase()
      ? { status: "verified", issue: null, recordHost: null, errors: [] }
      : {
          status: "pending",
          issue: { code: "routing_pending", foundTarget: null },
          recordHost,
          errors: [`${hostname} is ready; Vayada still has to route it to the booking page.`],
        };

  return {
    async check(hostname, propertyId) {
      const found = await dependencies.cloudflare.find(hostname);
      if (found && active(found)) return ready(hostname, propertyId, null);

      const [target, recordHost] = await Promise.all([
        dependencies.dns.cnameTarget(hostname),
        dependencies.dns.recordHost(hostname),
      ]);
      if (target === null) {
        return {
          status: "failed",
          issue: { code: "dns_record_missing", foundTarget: null },
          recordHost,
          errors: [
            `No CNAME record found for ${hostname}. Add a CNAME record pointing to ${BOOKING_CUSTOM_DOMAIN_CNAME_TARGET}.`,
          ],
        };
      }
      if (target !== BOOKING_CUSTOM_DOMAIN_CNAME_TARGET) {
        return {
          status: "failed",
          issue: { code: "dns_record_wrong_target", foundTarget: target },
          recordHost,
          errors: [
            `The CNAME record for ${hostname} points to ${target}. It must point to ${BOOKING_CUSTOM_DOMAIN_CNAME_TARGET}.`,
          ],
        };
      }

      let custom = found ?? (await dependencies.cloudflare.create(hostname));
      if (REJECTED_STATUSES.has(custom.status)) {
        return {
          status: "failed",
          issue: { code: "hostname_rejected", foundTarget: null },
          recordHost,
          errors: [`Cloudflare rejected ${hostname} (${custom.status}).`, ...custom.errors],
        };
      }
      // The record is right now: validation that timed out, expired or lost the CNAME starts over.
      if (
        custom.sslStatus.endsWith("_timed_out") ||
        custom.sslStatus === "expired" ||
        custom.status === "moved"
      ) {
        custom = await dependencies.cloudflare.restartValidation(custom.id);
      }
      if (active(custom)) return ready(hostname, propertyId, recordHost);
      return {
        status: "pending",
        issue: { code: "certificate_pending", foundTarget: null },
        recordHost,
        errors: custom.errors,
      };
    },
  };
}

function toCustomHostname(value: unknown): CloudflareCustomHostname {
  const row = (value ?? {}) as {
    id?: unknown;
    status?: unknown;
    ssl?: { status?: unknown; validation_errors?: Array<{ message?: unknown }> };
    verification_errors?: unknown[];
  };
  const errors = [
    ...(row.verification_errors ?? []),
    ...(row.ssl?.validation_errors ?? []).map((error) => error.message),
  ].filter((message): message is string => typeof message === "string" && message.length > 0);
  return {
    id: String(row.id ?? ""),
    status: String(row.status ?? "unknown"),
    sslStatus: String(row.ssl?.status ?? "unknown"),
    errors,
  };
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function isMissingName(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENODATA" || code === "ENOTFOUND";
}
