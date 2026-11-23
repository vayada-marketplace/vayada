import { NextResponse, type NextRequest } from "next/server";

/**
 * VAY-2516: the page-wide Content-Security-Policy for PMS and Booking Admin.
 *
 * The in-app assistant shows text an AI wrote after reading guest messages. If such text ever became
 * HTML, the policy stops it from running script: only scripts carrying this response's nonce run, and
 * scripts they load ('strict-dynamic': Next's chunks, Google Maps). It ships report-only first; the
 * framing rule is enforced separately in each app's next.config.js, because frame-ancestors does
 * nothing in a report-only policy.
 */

export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";
export const CSP_REPORT_PATH = "/csp-report";

/** vayada's image CDN and the bucket browsers upload media to (vayada-platform infra/media.tf). */
const VAYADA_MEDIA_CDN = "https://images.vayada.com";
/** Older photo hosts booking-web still shows images from (apps/booking-web/next.config.js). */
const VAYADA_OLDER_IMAGE_HOSTS = ["https://cdn.vayada.com", "https://api.vayada.com"];
const VAYADA_MEDIA_UPLOADS = "https://vayada-media-production.s3.eu-west-1.amazonaws.com";

/** What the Google Maps JavaScript API loads (Google's CSP guide for the Maps JavaScript API). */
const GOOGLE_MAPS = {
  connect: ["https://*.googleapis.com", "https://*.google.com", "https://*.gstatic.com"],
  img: [
    "https://*.googleapis.com",
    "https://*.gstatic.com",
    "https://*.google.com",
    "https://*.googleusercontent.com",
  ],
  font: ["https://fonts.gstatic.com"],
  style: ["https://fonts.googleapis.com"],
  frame: ["https://*.google.com"],
};

/** Pages served from this machine (next dev, the browser specs): the apps' local API, upload and image hosts. */
const LOCAL_HOSTS = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "https://*.localhost",
  "http://*.localhost:*",
];

export type ContentSecurityPolicyOptions = {
  nonce: string;
  /** Every URL the app's code fetches from (API base URLs from the environment); unset or invalid ones are skipped. */
  connectUrls: (string | undefined)[];
  /** `next dev`: React Refresh evaluates code. */
  allowEval: boolean;
  /** The page itself is served from this machine, so its API, upload and image hosts are local too. */
  allowLocalHosts: boolean;
};

export function contentSecurityPolicy({
  nonce,
  connectUrls,
  allowEval,
  allowLocalHosts,
}: ContentSecurityPolicyOptions): string {
  const apis = origins(connectUrls);
  const local = allowLocalHosts ? LOCAL_HOSTS : [];
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    [
      "script-src",
      [
        "'self'",
        `'nonce-${nonce}'`,
        "'strict-dynamic'",
        // Puts the first characters of blocked code into the violation; /csp-report never logs it.
        "'report-sample'",
        ...(allowEval ? ["'unsafe-eval'"] : []),
      ],
    ],
    // React's style attributes are inline styles; style can't run script.
    ["style-src", ["'self'", "'unsafe-inline'", ...GOOGLE_MAPS.style]],
    [
      "img-src",
      [
        "'self'",
        "data:",
        "blob:",
        VAYADA_MEDIA_CDN,
        ...VAYADA_OLDER_IMAGE_HOSTS,
        ...apis,
        ...GOOGLE_MAPS.img,
        ...local,
      ],
    ],
    ["font-src", ["'self'", "data:", ...GOOGLE_MAPS.font]],
    [
      "connect-src",
      [
        "'self'",
        ...apis,
        VAYADA_MEDIA_CDN,
        VAYADA_MEDIA_UPLOADS,
        ...GOOGLE_MAPS.connect,
        "data:",
        "blob:",
        ...local,
      ],
    ],
    ["frame-src", ["'self'", ...GOOGLE_MAPS.frame]],
    ["worker-src", ["'self'", "blob:"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    // Neither app posts a native form to another site; an injected form must not either.
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
    ["report-uri", [CSP_REPORT_PATH]],
  ];
  return directives
    .map(([name, sources]) =>
      [name, ...sources.filter((source, index) => sources.indexOf(source) === index)].join(" "),
    )
    .join("; ");
}

function origins(urls: (string | undefined)[]): string[] {
  const result: string[] = [];
  for (const value of urls) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") result.push(url.origin);
    } catch {
      // An unset or malformed variable adds nothing; the app's own fallback is then a local host.
    }
  }
  return result;
}

export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

/**
 * The proxy's answer for a page request: a fresh nonce per request, the policy on the response, and
 * the same policy on the request, where Next reads the nonce and puts it on its own scripts
 * (next/dist/server/app-render/app-render.js reads `content-security-policy-report-only` too).
 */
export function reportOnlyCspResponse(
  request: NextRequest,
  {
    connectUrls,
    development,
  }: { connectUrls: (string | undefined)[]; /** `next dev` */ development: boolean },
): NextResponse {
  // The address the browser asked for (Next's own URL carries the address it listens on).
  const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
  const policy = contentSecurityPolicy({
    nonce: createNonce(),
    connectUrls,
    allowEval: development,
    allowLocalHosts:
      development || host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost"),
  });
  const headers = new Headers(request.headers);
  // Next takes the nonce from an enforced policy first, so a client must not be able to send one.
  headers.delete("content-security-policy");
  headers.set(CSP_REPORT_ONLY_HEADER, policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set(CSP_REPORT_ONLY_HEADER, policy);
  return response;
}

const MAX_REPORT_BYTES = 16 * 1024;

/**
 * POST /csp-report: browsers send one report per violation. Each becomes one log line with the
 * directive, the blocked origin and the page path, never a query string, a script sample or a body,
 * so nothing a guest wrote and no token lands in the logs. Oversized or malformed bodies are dropped.
 */
export async function cspReportResponse(request: Request, app: string): Promise<Response> {
  // report-uri reports come as application/csp-report; anything else isn't a browser's report.
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/csp-report") return new Response(null, { status: 204 });
  const body = await readAtMost(request, MAX_REPORT_BYTES);
  const report = body === null ? null : parseReport(body);
  if (report) console.warn(JSON.stringify({ event: "csp_violation", app, ...report }));
  return new Response(null, { status: 204 });
}

async function readAtMost(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > limit || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

type CspViolation = {
  directive: string;
  blocked: string;
  page: string;
  source: string;
  disposition: string;
};

function parseReport(body: string): CspViolation | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const report =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)["csp-report"] : null;
  if (!report || typeof report !== "object") return null;
  const field = (name: string) => {
    const value = (report as Record<string, unknown>)[name];
    return typeof value === "string" ? value : "";
  };
  return {
    directive: keyword(field("effective-directive") || field("violated-directive").split(" ")[0]),
    blocked: urlPart(field("blocked-uri"), "origin"),
    page: urlPart(field("document-uri"), "path"),
    source: urlPart(field("source-file"), "path"),
    disposition: keyword(field("disposition")),
  };
}

function keyword(value: string): string {
  return /^[a-z-]{1,40}$/.test(value) ? value : "";
}

/** A URL's origin, or its origin and path; keywords such as "inline" and "eval" stay as they are. */
function urlPart(value: string, part: "origin" | "path"): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return url.protocol;
    return (part === "origin" ? url.origin : url.origin + url.pathname).slice(0, 200);
  } catch {
    return keyword(value);
  }
}
