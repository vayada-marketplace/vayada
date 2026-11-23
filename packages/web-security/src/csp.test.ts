import { NextRequest } from "next/server";
import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CSP_REPORT_ONLY_HEADER,
  contentSecurityPolicy,
  createNonce,
  cspReportResponse,
  reportOnlyCspResponse,
} from "./csp";

const directive = (policy: string, name: string) =>
  policy
    .split("; ")
    .find((entry) => entry.startsWith(`${name} `))
    ?.split(" ")
    .slice(1) ?? [];

const production = (connectUrls: (string | undefined)[] = []) =>
  contentSecurityPolicy({
    nonce: "bm9uY2U=",
    connectUrls,
    allowEval: false,
    allowLocalHosts: false,
  });

describe("contentSecurityPolicy", () => {
  it("runs only scripts with this response's nonce and what they load", () => {
    const scripts = directive(production(), "script-src");
    expect(scripts).toContain("'nonce-bm9uY2U='");
    expect(scripts).toContain("'strict-dynamic'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
  });

  it("is a policy Next reads its nonce from", () => {
    expect(getScriptNonceFromHeader(production())).toBe("bm9uY2U=");
  });

  it("can't be framed, loads no plugins, keeps the base URL and forms, and reports to the app", () => {
    const policy = production();
    expect(directive(policy, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(policy, "form-action")).toEqual(["'self'"]);
    expect(directive(policy, "object-src")).toEqual(["'none'"]);
    expect(directive(policy, "base-uri")).toEqual(["'self'"]);
    expect(directive(policy, "report-uri")).toEqual(["/csp-report"]);
    expect(directive(policy, "default-src")).toEqual(["'self'"]);
  });

  it("connects to the configured APIs by origin and skips unset or unusable values", () => {
    const connect = directive(
      production([
        "https://next-api.vayada.com/api",
        "https://next-api.vayada.com",
        undefined,
        "",
        "not a url",
        "javascript:alert(1)",
      ]),
      "connect-src",
    );
    expect(connect.filter((source) => source === "https://next-api.vayada.com")).toHaveLength(1);
    expect(connect).toContain("https://vayada-media-production.s3.eu-west-1.amazonaws.com");
    expect(connect.filter((source) => /javascript|a url|localhost/.test(source))).toEqual([]);
  });

  it("loads images from the media CDN and Google Maps, not from any https host", () => {
    const images = directive(production(), "img-src");
    expect(images).toEqual(
      expect.arrayContaining(["'self'", "data:", "blob:", "https://images.vayada.com"]),
    );
    expect(images).not.toContain("https:");
    expect(images).not.toContain("*");
  });

  it("allows eval and local hosts only when asked", () => {
    const local = contentSecurityPolicy({
      nonce: "bm9uY2U=",
      connectUrls: [],
      allowEval: false,
      allowLocalHosts: true,
    });
    expect(directive(local, "connect-src")).toContain("https://*.localhost");
    expect(directive(local, "img-src")).toContain("http://127.0.0.1:*");
    expect(directive(local, "script-src")).not.toContain("'unsafe-eval'");
    const dev = contentSecurityPolicy({
      nonce: "bm9uY2U=",
      connectUrls: [],
      allowEval: true,
      allowLocalHosts: true,
    });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(production().includes("localhost")).toBe(false);
  });
});

describe("createNonce", () => {
  it("returns 128 random bits as base64, different every time", () => {
    const nonces = Array.from({ length: 50 }, () => createNonce());
    expect(new Set(nonces).size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe("reportOnlyCspResponse", () => {
  // Next builds the proxy's URL from the address it listens on (0.0.0.0 in the image); the browser's
  // address is in the Host header.
  const policyFor = (host: string, development = false) =>
    reportOnlyCspResponse(new NextRequest("http://0.0.0.0:3004/dashboard", { headers: { host } }), {
      connectUrls: [],
      development,
    }).headers.get(CSP_REPORT_ONLY_HEADER) ?? "";

  it("allows local hosts only for pages the browser asked a local address for", () => {
    expect(policyFor("next-pms.vayada.com")).not.toContain("localhost");
    expect(policyFor("localhost.vayada.com")).not.toContain("localhost:");
    expect(policyFor("127.0.0.1:3013")).toContain("https://*.localhost");
    expect(policyFor("pms.localhost:3004")).toContain("https://*.localhost");
    expect(policyFor("127.0.0.1:3013")).not.toContain("'unsafe-eval'");
    expect(policyFor("localhost:3164", true)).toContain("'unsafe-eval'");
  });

  it("drops an enforced policy a client sends, so Next can't take its nonce from it", () => {
    const response = reportOnlyCspResponse(
      new NextRequest("https://next-pms.vayada.com/dashboard", {
        headers: { "content-security-policy": "script-src 'nonce-attacker'" },
      }),
      { connectUrls: [], development: false },
    );
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBeNull();
  });

  it("puts one fresh policy on the response and on the request Next renders", () => {
    const first = reportOnlyCspResponse(new NextRequest("https://next-pms.vayada.com/dashboard"), {
      connectUrls: ["https://next-api.vayada.com"],
      development: false,
    });
    const policy = first.headers.get(CSP_REPORT_ONLY_HEADER) ?? "";
    expect(directive(policy, "connect-src")).toContain("https://next-api.vayada.com");
    expect(first.headers.get("x-middleware-request-content-security-policy-report-only")).toBe(
      policy,
    );
    expect(first.headers.get("content-security-policy")).toBeNull();

    const second = reportOnlyCspResponse(new NextRequest("https://next-pms.vayada.com/dashboard"), {
      connectUrls: [],
      development: false,
    });
    expect(getScriptNonceFromHeader(second.headers.get(CSP_REPORT_ONLY_HEADER) ?? "")).not.toBe(
      getScriptNonceFromHeader(policy),
    );
  });
});

describe("cspReportResponse", () => {
  afterEach(() => vi.restoreAllMocks());

  const report = (body: string, headers: Record<string, string> = {}) =>
    new Request("https://next-pms.vayada.com/csp-report", {
      method: "POST",
      headers: { "content-type": "application/csp-report", ...headers },
      body,
    });

  it("logs the directive, the blocked origin and the page path, never queries or samples", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await cspReportResponse(
      report(
        JSON.stringify({
          "csp-report": {
            "document-uri": "https://next-pms.vayada.com/inbox?thread=42&token=secret",
            "violated-directive": "img-src",
            "effective-directive": "img-src",
            "blocked-uri": "https://evil.example/leak?data=guest-text",
            "source-file": "https://next-pms.vayada.com/_next/static/chunks/app.js?v=1",
            "script-sample": "Dear host, my passport number is",
            disposition: "report",
          },
        }),
      ),
      "pms-web",
    );

    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(warn.mock.calls[0][0]));
    expect(line).toEqual({
      event: "csp_violation",
      app: "pms-web",
      directive: "img-src",
      blocked: "https://evil.example",
      page: "https://next-pms.vayada.com/inbox",
      source: "https://next-pms.vayada.com/_next/static/chunks/app.js",
      disposition: "report",
    });
    expect(String(warn.mock.calls[0][0])).not.toMatch(/secret|guest-text|passport|thread/);
  });

  it("keeps keywords such as inline and eval", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await cspReportResponse(
      report(
        JSON.stringify({
          "csp-report": {
            "document-uri": "https://next-pms.vayada.com/login",
            "violated-directive": "script-src-elem 'self'",
            "blocked-uri": "inline",
            disposition: "report",
          },
        }),
      ),
      "pms-web",
    );
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
      directive: "script-src-elem",
      blocked: "inline",
    });
  });

  it("drops malformed, foreign, oversized and non-report bodies without logging", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const oversized = JSON.stringify({ "csp-report": { "blocked-uri": "x".repeat(20_000) } });
    for (const request of [
      report("not json"),
      report(JSON.stringify({ hello: "world" })),
      report(JSON.stringify([1, 2, 3])),
      report(oversized),
      report(oversized, { "content-length": String(oversized.length) }),
      report(JSON.stringify({ "csp-report": { "blocked-uri": "https://evil.example" } }), {
        "content-type": "text/plain",
      }),
    ]) {
      expect((await cspReportResponse(request, "booking-admin")).status).toBe(204);
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
