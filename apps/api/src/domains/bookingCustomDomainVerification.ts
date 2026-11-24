import { createHmac } from "node:crypto";
import { Resolver } from "node:dns/promises";

/** Every hotel domain points here; Cloudflare for SaaS serves it (fallback origin → the ALB). */
export const BOOKING_CUSTOM_DOMAIN_CNAME_TARGET = "custom.booking.vayada.com";
/** VAY-2579: a hotel proves its domain with a TXT record under this label of the domain. DNS allows
 * nothing next to a CNAME, so the record can't sit on the domain itself. */
export const BOOKING_CUSTOM_DOMAIN_PROOF_LABEL = "_vayada";
export const BOOKING_CUSTOM_DOMAIN_PROOF_PREFIX = "vayada-domain-verification=";

export type BookingCustomDomainIssueCode =
  | "dns_record_missing"
  | "dns_record_wrong_target"
  | "certificate_pending"
  | "routing_pending"
  | "hostname_rejected"
  | "check_unavailable"
  // VAY-2579: the domain's TXT record is missing, or holds another hotel's code.
  | "ownership_record_missing"
  | "ownership_record_mismatch";

/** The TXT record that proves a hotel owns its domain (VAY-2579). */
export type BookingCustomDomainProofRecord = { name: string; value: string };

export type BookingCustomDomainCheckResult = {
  status: "verified" | "pending" | "failed";
  issue: { code: BookingCustomDomainIssueCode; foundTarget: string | null } | null;
  /** The record's name as typed in the hotel's DNS panel ("booking" for booking.example.com);
   * null when unknown, and the page then shows the whole hostname. */
  recordHost: string | null;
  errors: string[];
  /** The Cloudflare hostname this check registered (VAY-2580). The domain row keeps it, so removing
   * the domain deletes that hostname and no other. */
  registeredHostnameId?: string;
  /** The ownership record's state when this check read it (VAY-2579); absent when it didn't. */
  proofStatus?: "verified" | "failed";
};

export type BookingCustomDomainVerifier = {
  check(hostname: string, propertyId: string): Promise<BookingCustomDomainCheckResult>;
  /**
   * The TXT record this property must add to prove the hostname is its own (VAY-2579); null when
   * none is needed: no proof secret configured, or platform already routes the hostname for this
   * property (ops confirmed those by hand).
   */
  proofRecord(hostname: string, propertyId: string): BookingCustomDomainProofRecord | null;
  /**
   * Deletes a Cloudflare hostname that a check registered (`registeredHostnameId`), once its domain
   * is removed or replaced (VAY-2580). "absent" when it was already gone.
   */
  release(hostnameId: string): Promise<"deleted" | "absent">;
};

export type CloudflareCustomHostname = {
  id: string;
  status: string;
  sslStatus: string;
  errors: string[];
};

export type CloudflareCustomHostnames = {
  find(hostname: string): Promise<CloudflareCustomHostname | null>;
  /** Registers the hostname; adopts it (`registered: false`) when it was registered a moment ago. */
  create(hostname: string): Promise<{ custom: CloudflareCustomHostname; registered: boolean }>;
  /** Asks Cloudflare to validate again after its validation window ran out. */
  restartValidation(id: string): Promise<CloudflareCustomHostname>;
  /** Deletes the hostname and its certificate; false when it was already gone. */
  remove(id: string): Promise<boolean>;
};

export type CustomDomainDns = {
  /** The hostname's CNAME target, or null when it has none (no record, or no such name). */
  cnameTarget(hostname: string): Promise<string | null>;
  recordHost(hostname: string): Promise<string | null>;
  /** The name's TXT values (chunks joined); empty when it has none. */
  txtValues(name: string): Promise<string[]>;
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
const WELL_FORMED_PROOF = new RegExp(`^${BOOKING_CUSTOM_DOMAIN_PROOF_PREFIX}[0-9a-f]{32}$`);
const HOSTNAME_NOT_FOUND = 1436;
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
        const custom = toCustomHostname(
          await call(base, {
            method: "POST",
            body: JSON.stringify({ hostname, ssl: SSL_SETTINGS }),
          }),
        );
        return { custom, registered: true };
      } catch (error) {
        // Created a moment ago, most likely by a concurrent check, which records it itself.
        if (
          error instanceof CloudflareCustomHostnameError &&
          error.codes.includes(HOSTNAME_ALREADY_EXISTS)
        ) {
          const created = await find(hostname);
          if (created) return { custom: created, registered: false };
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
    async remove(id) {
      try {
        await call(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
        return true;
      } catch (error) {
        // Already deleted (by hand, or by a concurrent removal).
        if (
          error instanceof CloudflareCustomHostnameError &&
          (error.httpStatus === 404 || error.codes.includes(HOSTNAME_NOT_FOUND))
        ) {
          return false;
        }
        throw error;
      }
    },
  };
}

export function createCustomDomainDns(
  resolver: Pick<Resolver, "resolveCname" | "resolveSoa" | "resolveTxt"> = new Resolver({
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
    async txtValues(name) {
      try {
        return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(""));
      } catch (error) {
        if (isMissingName(error)) return [];
        throw error;
      }
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
 *
 * VAY-2579: with a proof secret, a hostname platform doesn't route for this property must also carry
 * this property's TXT record (`proofRecord`) before it is registered or counts as ready. An old-system
 * hotel's hostname is active in Cloudflare already, so it needs the record too.
 */
export function createBookingCustomDomainVerifier(dependencies: {
  cloudflare: CloudflareCustomHostnames;
  dns: CustomDomainDns;
  /** hostname → the property id it is routed for. */
  routes: ReadonlyMap<string, string>;
  /** Keys each property's ownership code; without it no TXT record is asked for (today's rule). */
  proofSecret?: string;
}): BookingCustomDomainVerifier {
  const active = (custom: CloudflareCustomHostname) =>
    custom.status === "active" && custom.sslStatus === "active";
  const proofRecord = (hostname: string, propertyId: string) => {
    const property = propertyId.toLowerCase();
    if (!dependencies.proofSecret || dependencies.routes.get(hostname) === property) return null;
    const code = createHmac("sha256", dependencies.proofSecret)
      .update(`${property}\n${hostname}`)
      .digest("hex")
      .slice(0, 32);
    return {
      name: `${BOOKING_CUSTOM_DOMAIN_PROOF_LABEL}.${hostname}`,
      value: `${BOOKING_CUSTOM_DOMAIN_PROOF_PREFIX}${code}`,
    };
  };
  // Null when the record proves the hostname for this property; otherwise why not.
  const ownershipFailure = async (
    proof: BookingCustomDomainProofRecord,
    recordHost: string | null,
  ): Promise<BookingCustomDomainCheckResult | null> => {
    const codes = (await dependencies.dns.txtValues(proof.name))
      .map((value) =>
        value
          .trim()
          .replace(/^"(.*)"$/, "$1")
          .trim()
          .toLowerCase(),
      )
      .filter((value) => value.startsWith(BOOKING_CUSTOM_DOMAIN_PROOF_PREFIX));
    if (codes.includes(proof.value)) return null;
    // Only a well-formed code is another hotel's; a mistyped or cut-off paste is just not there yet.
    const mismatch = codes.some((value) => WELL_FORMED_PROOF.test(value));
    return {
      status: "failed",
      issue: {
        code: mismatch ? "ownership_record_mismatch" : "ownership_record_missing",
        foundTarget: null,
      },
      recordHost,
      errors: [
        mismatch
          ? `The TXT record ${proof.name} holds another hotel's code. Only this hotel's code proves the domain is its own.`
          : `No TXT record ${proof.name} with this hotel's code found. Add it to prove the domain is yours.`,
      ],
      proofStatus: "failed",
    };
  };
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
      const proof = proofRecord(hostname, propertyId);
      const proven = proof ? ({ proofStatus: "verified" } as const) : {};
      const found = await dependencies.cloudflare.find(hostname);
      if (found && active(found)) {
        if (!proof) return ready(hostname, propertyId, null);
        const recordHost = await dependencies.dns.recordHost(hostname);
        const failure = await ownershipFailure(proof, recordHost);
        return failure ?? { ...ready(hostname, propertyId, recordHost), ...proven };
      }

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

      if (proof) {
        const failure = await ownershipFailure(proof, recordHost);
        if (failure) return failure;
      }

      // Only a hostname this check registered is recorded, and only such a one is ever deleted: the
      // old booking-api's hostnames share the zone, and its pages may still use them.
      let registeredHostnameId: string | undefined;
      let custom = found;
      if (!custom) {
        const created = await dependencies.cloudflare.create(hostname);
        custom = created.custom;
        if (created.registered && custom.id) registeredHostnameId = custom.id;
      }
      const registered = registeredHostnameId ? { registeredHostnameId } : {};
      if (REJECTED_STATUSES.has(custom.status) || REJECTED_STATUSES.has(custom.sslStatus)) {
        return {
          status: "failed",
          issue: { code: "hostname_rejected", foundTarget: null },
          recordHost,
          errors: [
            `Cloudflare rejected ${hostname} (${REJECTED_STATUSES.has(custom.status) ? custom.status : `certificate ${custom.sslStatus}`}).`,
            ...custom.errors,
          ],
          ...registered,
          ...proven,
        };
      }
      // The record is right now: validation that timed out, expired or lost the CNAME starts over.
      if (
        custom.sslStatus.endsWith("_timed_out") ||
        custom.sslStatus === "expired" ||
        custom.sslStatus === "inactive" ||
        custom.status === "moved"
      ) {
        custom = await dependencies.cloudflare.restartValidation(custom.id);
      }
      if (active(custom)) {
        return { ...ready(hostname, propertyId, recordHost), ...registered, ...proven };
      }
      return {
        status: "pending",
        issue: { code: "certificate_pending", foundTarget: null },
        recordHost,
        errors: custom.errors,
        ...registered,
        ...proven,
      };
    },
    proofRecord,
    async release(hostnameId) {
      return (await dependencies.cloudflare.remove(hostnameId)) ? "deleted" : "absent";
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
