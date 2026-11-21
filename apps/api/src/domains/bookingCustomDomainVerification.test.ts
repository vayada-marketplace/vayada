import { describe, expect, it, vi } from "vitest";

import {
  CloudflareCustomHostnameError,
  createBookingCustomDomainVerifier,
  createCloudflareCustomHostnames,
  createCustomDomainDns,
  type CloudflareCustomHostname,
  type CloudflareCustomHostnames,
  type CustomDomainDns,
} from "./bookingCustomDomainVerification.js";

const hostname = "booking.hotel.example";
const base = "https://api.cloudflare.com/client/v4/zones/zone-1/custom_hostnames";

function cloudflareResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function hostnameRow(status: string, sslStatus: string, extra: Record<string, unknown> = {}) {
  return { id: "ch-1", hostname, status, ssl: { status: sslStatus }, ...extra };
}

describe("Cloudflare custom hostnames", () => {
  it("finds an existing hostname by exact name with the zone token", async () => {
    const fetch = vi.fn(async () =>
      cloudflareResponse(200, {
        success: true,
        result: [
          { ...hostnameRow("active", "active"), hostname: `www.${hostname}` },
          hostnameRow("active", "active", { verification_errors: [] }),
        ],
      }),
    );
    const cloudflare = createCloudflareCustomHostnames({
      apiToken: "secret-token",
      zoneId: "zone-1",
      fetch,
    });

    await expect(cloudflare.find(hostname)).resolves.toEqual({
      id: "ch-1",
      status: "active",
      sslStatus: "active",
      errors: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${base}?hostname=booking.hotel.example`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    expect(init.method).toBeUndefined();
  });

  it("creates a missing hostname with HTTP validation, as the old booking-api did", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(
      cloudflareResponse(200, {
        success: true,
        result: hostnameRow("pending", "initializing", {
          verification_errors: ["custom hostname does not CNAME to this zone."],
          ssl: { status: "pending_validation", validation_errors: [{ message: "CAA blocks" }] },
        }),
      }),
    );
    const cloudflare = createCloudflareCustomHostnames({ apiToken: "t", zoneId: "zone-1", fetch });

    await expect(cloudflare.create(hostname)).resolves.toEqual({
      id: "ch-1",
      status: "pending",
      sslStatus: "pending_validation",
      errors: ["custom hostname does not CNAME to this zone.", "CAA blocks"],
    });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(base);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      hostname,
      ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
    });
  });

  it("adopts a hostname another check created a moment ago", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        cloudflareResponse(409, { success: false, errors: [{ code: 1406, message: "exists" }] }),
      )
      .mockResolvedValueOnce(
        cloudflareResponse(200, {
          success: true,
          result: [hostnameRow("pending", "pending_validation")],
        }),
      );
    const cloudflare = createCloudflareCustomHostnames({ apiToken: "t", zoneId: "zone-1", fetch });

    await expect(cloudflare.create(hostname)).resolves.toMatchObject({ id: "ch-1" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports a failed call with its status and codes only, never the token", async () => {
    const fetch = vi.fn(async () =>
      cloudflareResponse(403, {
        success: false,
        errors: [{ code: 9109, message: "Unauthorized" }],
      }),
    );
    const cloudflare = createCloudflareCustomHostnames({
      apiToken: "secret-token",
      zoneId: "zone-1",
      fetch,
    });

    const error = await cloudflare.find(hostname).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudflareCustomHostnameError);
    expect(error).toMatchObject({ httpStatus: 403, codes: [9109] });
    expect(String((error as Error).message)).not.toContain("secret-token");
  });

  it("restarts validation with the same SSL settings", async () => {
    const fetch = vi.fn(async () =>
      cloudflareResponse(200, {
        success: true,
        result: hostnameRow("pending", "pending_validation"),
      }),
    );
    const cloudflare = createCloudflareCustomHostnames({ apiToken: "t", zoneId: "zone-1", fetch });

    await expect(cloudflare.restartValidation("ch-1")).resolves.toMatchObject({
      sslStatus: "pending_validation",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${base}/ch-1`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
    });
  });
});

describe("custom-domain DNS", () => {
  const dnsError = (code: string) => Object.assign(new Error(code), { code });

  it("reads the CNAME target and treats a missing name or record as none", async () => {
    const resolveCname = vi
      .fn()
      .mockResolvedValueOnce(["Custom.Booking.Vayada.com."])
      .mockRejectedValueOnce(dnsError("ENODATA"))
      .mockRejectedValueOnce(dnsError("ENOTFOUND"))
      .mockRejectedValueOnce(dnsError("ETIMEOUT"));
    const dns = createCustomDomainDns({ resolveCname, resolveSoa: vi.fn() });

    await expect(dns.cnameTarget(hostname)).resolves.toBe("custom.booking.vayada.com");
    await expect(dns.cnameTarget(hostname)).resolves.toBeNull();
    await expect(dns.cnameTarget(hostname)).resolves.toBeNull();
    await expect(dns.cnameTarget(hostname)).rejects.toMatchObject({ code: "ETIMEOUT" });
  });

  it("names the record relative to the hotel's DNS zone", async () => {
    const zones = new Set(["hotel.example", "hotel.co.id"]);
    const resolveSoa = vi.fn(async (name: string) => {
      if (zones.has(name)) return {};
      throw dnsError("ENODATA");
    });
    const dns = createCustomDomainDns({ resolveCname: vi.fn(), resolveSoa: resolveSoa as never });

    await expect(dns.recordHost("booking.hotel.example")).resolves.toBe("booking");
    await expect(dns.recordHost("www.booking.hotel.co.id")).resolves.toBe("www.booking");
    // A CNAME can't sit at a zone's apex, and an SOA query for the name would follow its CNAME.
    await expect(dns.recordHost("hotel.example")).resolves.toBeNull();
    await expect(dns.recordHost("booking.unknown.example")).resolves.toBeNull();
    expect(resolveSoa).not.toHaveBeenCalledWith("example");
    expect(resolveSoa).not.toHaveBeenCalledWith("booking.hotel.example");
  });
});

describe("custom-domain verifier", () => {
  const propertyId = "aaaa0000-0000-4000-8000-000000000001";
  const active = { id: "ch-1", status: "active", sslStatus: "active", errors: [] };
  const pending = { id: "ch-1", status: "pending", sslStatus: "pending_validation", errors: [] };
  function verifier(
    found: CloudflareCustomHostname | null,
    dnsAnswer: { target: string | null; host?: string | null },
    options: { created?: CloudflareCustomHostname; routes?: Map<string, string> } = {},
  ) {
    const cloudflare: CloudflareCustomHostnames = {
      find: vi.fn(async () => found),
      create: vi.fn(async () => options.created ?? pending),
      restartValidation: vi.fn(async () => ({ ...pending, sslStatus: "pending_validation" })),
    };
    const dns: CustomDomainDns = {
      cnameTarget: vi.fn(async () => dnsAnswer.target),
      recordHost: vi.fn(async () => dnsAnswer.host ?? "booking"),
    };
    const routes = options.routes ?? new Map([[hostname, propertyId]]);
    const { check } = createBookingCustomDomainVerifier({ cloudflare, dns, routes });
    return { cloudflare, dns, check: (host = hostname) => check(host, propertyId.toUpperCase()) };
  }

  it("verifies an active hostname routed for this property, without asking DNS", async () => {
    const { dns, check } = verifier(active, { target: null });

    await expect(check()).resolves.toEqual({
      status: "verified",
      issue: null,
      recordHost: null,
      errors: [],
    });
    expect(dns.cnameTarget).not.toHaveBeenCalled();
  });

  it("keeps an active hostname pending until Vayada routes it for this property", async () => {
    for (const routes of [
      new Map<string, string>(),
      new Map([[hostname, "bbbb0000-0000-4000-8000-000000000002"]]),
    ]) {
      const { check } = verifier(active, { target: null }, { routes });

      await expect(check()).resolves.toEqual({
        status: "pending",
        issue: { code: "routing_pending", foundTarget: null },
        recordHost: null,
        errors: [
          "booking.hotel.example is ready; Vayada still has to route it to the booking page.",
        ],
      });
    }
  });

  it("fails with the exact record when the CNAME is missing, registering nothing", async () => {
    const { cloudflare, check } = verifier(null, { target: null });

    await expect(check()).resolves.toEqual({
      status: "failed",
      issue: { code: "dns_record_missing", foundTarget: null },
      recordHost: "booking",
      errors: [
        "No CNAME record found for booking.hotel.example. Add a CNAME record pointing to custom.booking.vayada.com.",
      ],
    });
    expect(cloudflare.create).not.toHaveBeenCalled();
  });

  it("fails naming the wrong target", async () => {
    const { cloudflare, check } = verifier(null, { target: "hotel.example" });

    await expect(check()).resolves.toMatchObject({
      status: "failed",
      issue: { code: "dns_record_wrong_target", foundTarget: "hotel.example" },
    });
    expect(cloudflare.create).not.toHaveBeenCalled();
  });

  it("registers the hostname once the record is right and waits for the certificate", async () => {
    const { cloudflare, check } = verifier(null, { target: "custom.booking.vayada.com" });

    await expect(check()).resolves.toEqual({
      status: "pending",
      issue: { code: "certificate_pending", foundTarget: null },
      recordHost: "booking",
      errors: [],
    });
    expect(cloudflare.create).toHaveBeenCalledWith(hostname);
  });

  it("keeps waiting on an existing hostname without registering it again", async () => {
    const { cloudflare, check } = verifier(
      { ...pending, errors: ["custom hostname does not CNAME to this zone."] },
      { target: "custom.booking.vayada.com" },
    );

    await expect(check()).resolves.toMatchObject({
      status: "pending",
      issue: { code: "certificate_pending" },
      errors: ["custom hostname does not CNAME to this zone."],
    });
    expect(cloudflare.create).not.toHaveBeenCalled();
    expect(cloudflare.restartValidation).not.toHaveBeenCalled();
  });

  it("restarts validation that timed out, expired or lost the CNAME once the record is right", async () => {
    for (const stale of [
      { ...pending, sslStatus: "validation_timed_out" },
      { ...pending, sslStatus: "deployment_timed_out" },
      { ...active, sslStatus: "expired" },
      { ...pending, sslStatus: "inactive" },
      { ...pending, status: "moved" },
    ]) {
      const { cloudflare, check } = verifier(stale, { target: "custom.booking.vayada.com" });

      await expect(check()).resolves.toMatchObject({
        status: "pending",
        issue: { code: "certificate_pending" },
      });
      expect(cloudflare.restartValidation).toHaveBeenCalledWith("ch-1");
    }
  });

  it("fails when Cloudflare refuses or removes the hostname", async () => {
    for (const status of ["blocked", "deleted", "pending_deletion"]) {
      const { cloudflare, check } = verifier(
        { ...pending, status, errors: ["blocked for abuse"] },
        { target: "custom.booking.vayada.com" },
      );

      await expect(check()).resolves.toEqual({
        status: "failed",
        issue: { code: "hostname_rejected", foundTarget: null },
        recordHost: "booking",
        errors: [`Cloudflare rejected booking.hotel.example (${status}).`, "blocked for abuse"],
      });
      expect(cloudflare.restartValidation).not.toHaveBeenCalled();
    }

    const { check } = verifier(
      { ...pending, sslStatus: "deleted" },
      { target: "custom.booking.vayada.com" },
    );
    await expect(check()).resolves.toMatchObject({
      status: "failed",
      issue: { code: "hostname_rejected" },
      errors: ["Cloudflare rejected booking.hotel.example (certificate deleted)."],
    });
  });
});
